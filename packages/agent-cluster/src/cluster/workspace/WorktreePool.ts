/**
 * WorktreePool — a fixed set of reusable git worktrees per project, so workers of one project
 * run in parallel without sharing an index or seeing each other's half-written files.
 *
 * A checkout is cheap and `node_modules` is not, so slots are never made per task: a slot is
 * created on first use, keeps its `node_modules`, and installs again only when the lockfile
 * changed. Leases live in SQLite so an adopted worker keeps its slot across a daemon restart.
 *
 * Planners lease from their own slots. A planner holds its lease while blocked in `hub_wait`,
 * so sharing one pool would let waiting planners take the slots their children need. Planners
 * only read, so their slots never install and cost a bare checkout.
 *
 * Every worktree lives at `<worktreeRoot>/<project>/<name>` with a random name; what a slot is for
 * is its `kind` in SQLite, never its name. The project checkout is never a slot.
 */

import type { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { logger } from '@qqbot/shared';
import type { ProjectEntry, ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import type { ClusterConfig } from '../config';
import { git, runGit } from '../git';
import type { WorkspaceCatchUp, WorktreePoolStatus } from '../types';

export type SlotKind = 'executor' | 'planner';
type StoredSlotKind = SlotKind | 'publish';

export interface SlotLease {
  project: string;
  slot: string;
  kind: SlotKind;
  path: string;
  taskId: string;
  leasedAt: string;
}

interface SlotRow {
  project: string;
  slot: string;
  kind: string;
  path: string;
  taskId: string | null;
  leasedAt: string | null;
  lockHash: string | null;
}

const CATCH_UP_MAX_COMMITS = 30;
const CATCH_UP_MAX_FILES = 50;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const DEFAULT_INSTALL: Partial<Record<ProjectEntry['type'], string>> = { bun: 'bun install', node: 'npm install' };

/**
 * Run a shell command with its output on `logPath`, ending it if it outlives the timeout or
 * `signal` aborts. The command gets its own process group so the kill reaches what the shell
 * started, not only the shell. Throws on failure with the tail of the log, which is what a
 * person needs to see.
 */
export async function runLoggedCommand(
  command: string,
  cwd: string,
  logPath: string,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
        detached: true,
      });
      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, sig);
          } catch {
            child.kill(sig);
          }
        }
      };
      const timer = setTimeout(() => killGroup('SIGKILL'), COMMAND_TIMEOUT_MS);
      const onAbort = () => killGroup('SIGTERM');
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', (err) => {
        done();
        reject(err);
      });
      child.once('exit', (exitCode) => {
        done();
        resolve(exitCode);
      });
    });
    if (code !== 0) {
      const tail = readFileSync(logPath, 'utf8').slice(-1000).trim();
      throw new Error(`\`${command}\` exited with ${code ?? 'a signal'} in ${cwd}: ${tail}`);
    }
  } finally {
    closeSync(log);
  }
}

/**
 * Git environment for commands run inside a slot. A configured `worktreeRoot` can sit inside a
 * project checkout, so in a slot that lost its `.git` file, git would walk up and act on that
 * checkout. The ceiling makes it fail instead: `checkout -f` must never reach the main checkout.
 */
function slotEnv(path: string): Record<string, string> {
  return { GIT_CEILING_DIRECTORIES: dirname(path) };
}

export class WorktreePool {
  constructor(
    private readonly config: ClusterConfig,
    private readonly db: Database,
    private readonly projects: ProjectRegistry,
  ) {}

  private get root(): string {
    return this.config.worktreeRoot;
  }

  /** How many slots of each kind the project gets; none for a project that is not a git repository. */
  capacity(entry: ProjectEntry): { executor: number; planner: number } {
    if (!existsSync(join(entry.path, '.git'))) {
      return { executor: 0, planner: 0 };
    }
    const enabled = Object.values(this.config.workerTemplates).filter((t) => t.enabled !== false);
    const total = (templates: typeof enabled) => templates.reduce((sum, t) => sum + t.maxConcurrent, 0);
    const executor =
      entry.worktrees ??
      Math.min(
        this.config.maxConcurrentWorkers,
        this.config.projects[entry.alias]?.maxWorkers ?? Number.POSITIVE_INFINITY,
        total(enabled.filter((t) => t.role !== 'planner')),
      );
    if (executor === 0) {
      return { executor: 0, planner: 0 };
    }
    return {
      executor,
      planner: Math.min(this.config.maxConcurrentWorkers, total(enabled.filter((t) => t.role === 'planner'))),
    };
  }

  isPooled(entry: ProjectEntry): boolean {
    return this.capacity(entry).executor > 0;
  }

  /** Take a free slot of this kind, or a new one while the pool has room; null when all are leased. Synchronous, so two dispatches cannot pick the same one. */
  lease(entry: ProjectEntry, kind: SlotKind, taskId: string): SlotLease | null {
    const project = this.directoryName(entry);
    const slots = this.rows(project, kind);
    const current = slots.filter((row) => this.inRoot(row.path));
    const free = current.find((row) => row.taskId === null);
    const inUse = slots.filter((row) => row.taskId !== null || this.inRoot(row.path));
    if (!free && inUse.length >= this.capacity(entry)[kind]) {
      return null;
    }
    const slot = free?.slot ?? newSlotName();
    const lease: SlotLease = {
      project,
      slot,
      kind,
      path: free?.path ?? join(this.root, project, slot),
      taskId,
      leasedAt: new Date().toISOString(),
    };
    this.db
      .query(
        `INSERT INTO cluster_worktree_slots (project, slot, kind, path, taskId, leasedAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, slot) DO UPDATE SET taskId = excluded.taskId, leasedAt = excluded.leasedAt`,
      )
      .run(project, slot, kind, lease.path, taskId, lease.leasedAt);
    return lease;
  }

  /**
   * Lease the slot at `path` again for the task that used it before, if it is free: a resumed
   * session must run where it was created. Null when the slot is leased to another task or gone.
   */
  leaseAgain(entry: ProjectEntry, kind: SlotKind, taskId: string, path: string): SlotLease | null {
    const project = this.directoryName(entry);
    const row = this.db
      .query('SELECT * FROM cluster_worktree_slots WHERE project = ? AND path = ? AND kind = ? LIMIT 1')
      .get(project, path, kind) as SlotRow | null;
    if (!row || row.taskId !== null || !this.inRoot(row.path)) {
      return null;
    }
    const leasedAt = new Date().toISOString();
    this.db
      .query(
        'UPDATE cluster_worktree_slots SET taskId = ?, leasedAt = ? WHERE project = ? AND slot = ? AND taskId IS NULL',
      )
      .run(taskId, leasedAt, project, row.slot);
    return { ...toLease(row), taskId, leasedAt };
  }

  leaseOf(taskId: string): SlotLease | null {
    const row = this.db
      .query('SELECT * FROM cluster_worktree_slots WHERE taskId = ? LIMIT 1')
      .get(taskId) as SlotRow | null;
    return row ? toLease(row) : null;
  }

  leases(): SlotLease[] {
    const rows = this.db.query('SELECT * FROM cluster_worktree_slots WHERE taskId IS NOT NULL').all() as SlotRow[];
    return rows.map(toLease);
  }

  /** Bring a leased slot to `branch`, cut from `startPoint`, with dependencies matching its lockfile. */
  async prepare(lease: SlotLease, entry: ProjectEntry, branch: string, startPoint: string): Promise<void> {
    await this.ensureWorktree(lease.path, entry);
    await git(lease.path, ['checkout', '-f', '-B', branch, startPoint], slotEnv(lease.path));
    await git(lease.path, ['clean', '-fd'], slotEnv(lease.path));
    if (lease.kind === 'executor') {
      await this.installIfLockChanged(lease.project, lease.slot, lease.path, entry, `${lease.taskId}.install.log`);
    }
  }

  /**
   * Put a slot leased again back on the task's own branch, as the task left it, and move the
   * branch to the integration tip when that loses nothing. A slot the task still holds is left
   * alone: the worker's uncommitted work is in it.
   */
  async reopen(
    lease: SlotLease,
    entry: ProjectEntry,
    branch: string,
    integrationBranch: string,
    held: boolean,
  ): Promise<WorkspaceCatchUp | undefined> {
    if (held) {
      return undefined;
    }
    await this.ensureWorktree(lease.path, entry);
    await git(lease.path, ['checkout', '-f', branch], slotEnv(lease.path));
    await git(lease.path, ['clean', '-fd'], slotEnv(lease.path));
    const catchUp = await this.catchUp(lease, branch, integrationBranch);
    if (lease.kind === 'executor') {
      await this.installIfLockChanged(lease.project, lease.slot, lease.path, entry, `${lease.taskId}.install.log`);
    }
    return catchUp;
  }

  private async catchUp(lease: SlotLease, branch: string, integrationBranch: string): Promise<WorkspaceCatchUp> {
    const env = slotEnv(lease.path);
    const previousHead = await git(lease.path, ['rev-parse', 'HEAD'], env);
    const integrationHead = await git(lease.path, ['rev-parse', integrationBranch], env);
    const log = await git(
      lease.path,
      ['log', `--max-count=${CATCH_UP_MAX_COMMITS}`, '--format=%H%x09%s', `${previousHead}..${integrationHead}`],
      env,
    );
    const commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t');
        return { sha, subject: subject.join('\t') };
      });
    const changes = await git(lease.path, ['diff', '--name-status', previousHead, integrationHead], env);
    const changedFiles = changes.split('\n').filter(Boolean).slice(0, CATCH_UP_MAX_FILES);

    if (previousHead === integrationHead) {
      return { previousHead, head: previousHead, advanced: false, commits, changedFiles };
    }
    const ancestor = await runGit(lease.path, ['merge-base', '--is-ancestor', previousHead, integrationHead], env);
    if (ancestor.code !== 0) {
      return {
        previousHead,
        head: previousHead,
        advanced: false,
        commits,
        changedFiles,
        reason: `${branch} has commits that ${integrationBranch} does not`,
      };
    }
    await git(lease.path, ['checkout', '-f', '-B', branch, integrationHead], env);
    return { previousHead, head: integrationHead, advanced: true, commits, changedFiles };
  }

  /** What `git status --porcelain` shows in the slot; empty when it is clean or was never set up. */
  async uncommitted(lease: SlotLease): Promise<string[]> {
    const status = await runGit(lease.path, ['status', '--porcelain'], slotEnv(lease.path)).catch(() => null);
    if (!status || status.code !== 0) {
      return [];
    }
    return status.stdout.split('\n').filter(Boolean);
  }

  /**
   * Clean the slot and free it. Detaching lets another worktree check out the branch the task
   * used. A slot that cannot be cleaned is removed instead of being handed to the next task
   * in an unknown state; the next lease rebuilds it.
   */
  async release(lease: SlotLease): Promise<void> {
    try {
      if (existsSync(lease.path)) {
        await git(lease.path, ['checkout', '-f', '--detach'], slotEnv(lease.path));
        await git(lease.path, ['clean', '-fd'], slotEnv(lease.path));
      }
    } catch (err) {
      logger.warn(`[WorktreePool] Removing slot ${lease.path}, which could not be reset:`, err);
      this.db
        .query('UPDATE cluster_worktree_slots SET lockHash = NULL WHERE project = ? AND slot = ?')
        .run(lease.project, lease.slot);
      rmSync(lease.path, { recursive: true, force: true });
    } finally {
      this.db
        .query(
          'UPDATE cluster_worktree_slots SET taskId = NULL, leasedAt = NULL WHERE project = ? AND slot = ? AND taskId = ?',
        )
        .run(lease.project, lease.slot, lease.taskId);
    }
  }

  /**
   * The project's publish worktree, on `rev` with its dependencies installed. It is detached, so
   * the integration branch stays free for the owner to check out. Callers run one at a time.
   */
  async preparePublish(entry: ProjectEntry, rev: string, logName: string): Promise<string> {
    const project = this.directoryName(entry);
    let slot = this.rows(project, 'publish').find((row) => this.inRoot(row.path));
    if (!slot) {
      const name = newSlotName();
      const path = join(this.root, project, name);
      this.db
        .query(`INSERT INTO cluster_worktree_slots (project, slot, kind, path) VALUES (?, ?, 'publish', ?)`)
        .run(project, name, path);
      slot = { project, slot: name, kind: 'publish', path, taskId: null, leasedAt: null, lockHash: null };
    }
    await this.ensureWorktree(slot.path, entry);
    await git(slot.path, ['checkout', '-f', '--detach', rev], slotEnv(slot.path));
    await git(slot.path, ['clean', '-fd'], slotEnv(slot.path));
    await this.installIfLockChanged(project, slot.slot, slot.path, entry, logName);
    return slot.path;
  }

  status(): WorktreePoolStatus[] {
    const leases = this.leases();
    return this.projects
      .list()
      .filter((entry) => this.isPooled(entry))
      .map((entry) => {
        const { executor, planner } = this.capacity(entry);
        const project = this.directoryName(entry);
        return {
          project: entry.alias,
          size: executor,
          plannerSize: planner,
          leased: leases
            .filter((lease) => lease.project === project)
            .map(({ slot, kind, path, taskId, leasedAt }) => ({ slot, kind, path, taskId, leasedAt })),
        };
      });
  }

  /**
   * Remove every worktree the pool does not claim: a free slot beyond the configured size, a free
   * slot left outside `worktreeRoot`, a slot of a project no longer registered, and any directory
   * in the root without a slot. A leased slot is always claimed. Answers the removed paths;
   * `dryRun` only lists them.
   */
  async gc(options?: { dryRun?: boolean }): Promise<string[]> {
    const entries = new Map(this.projects.list().map((entry) => [this.directoryName(entry), entry]));
    const removed: string[] = [];
    const remove = async (path: string, entry: ProjectEntry | undefined) => {
      removed.push(path);
      if (options?.dryRun) {
        return;
      }
      if (entry) {
        await runGit(entry.path, ['worktree', 'remove', '--force', path]);
      }
      rmSync(path, { recursive: true, force: true });
      this.db.query('DELETE FROM cluster_worktree_slots WHERE path = ?').run(path);
    };

    const rows = this.db.query('SELECT * FROM cluster_worktree_slots').all() as SlotRow[];
    const surplus = rows.filter((row) => row.taskId === null && !this.claimedWhenFree(row, entries.get(row.project)));
    for (const row of surplus) {
      await remove(row.path, entries.get(row.project));
    }

    for (const project of existsSync(this.root) ? readdirSync(this.root) : []) {
      const projectDir = join(this.root, project);
      if (!statSync(projectDir).isDirectory()) {
        continue;
      }
      for (const name of readdirSync(projectDir)) {
        const path = join(projectDir, name);
        // Asked per directory, and after listing it: a lease writes its row before its worktree
        // exists, so a directory with no row now is not one a dispatch is creating. Only the
        // pool's own names go: the root is configurable, and a root pointed at the wrong place
        // must not cost its owner anything the pool did not create.
        if (statSync(path).isDirectory() && SLOT_NAME.test(name) && !removed.includes(path) && !this.hasSlot(path)) {
          await remove(path, entries.get(project));
        }
      }
      if (!options?.dryRun && readdirSync(projectDir).length === 0) {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }

    if (!options?.dryRun) {
      for (const entry of entries.values()) {
        await runGit(entry.path, ['worktree', 'prune']);
      }
    }
    return removed;
  }

  private rows(project: string, kind: StoredSlotKind): SlotRow[] {
    return this.db
      .query('SELECT * FROM cluster_worktree_slots WHERE project = ? AND kind = ? ORDER BY slot')
      .all(project, kind) as SlotRow[];
  }

  private inRoot(path: string): boolean {
    return path.startsWith(this.root + sep);
  }

  private hasSlot(path: string): boolean {
    return this.db.query('SELECT 1 FROM cluster_worktree_slots WHERE path = ?').get(path) !== null;
  }

  /** Whether a free slot is one the pool would still hand out. */
  private claimedWhenFree(row: SlotRow, entry: ProjectEntry | undefined): boolean {
    if (!entry || !this.inRoot(row.path)) {
      return false;
    }
    if (row.kind === 'publish') {
      return (
        Boolean(entry.publish) && this.rows(row.project, 'publish').find((r) => this.inRoot(r.path))?.path === row.path
      );
    }
    const kind = row.kind as SlotKind;
    const slots = this.rows(row.project, kind).filter((r) => r.taskId !== null || this.inRoot(r.path));
    // Leased slots come first: they stay whatever the size, so they use up the size first.
    const ordered = [...slots.filter((r) => r.taskId !== null), ...slots.filter((r) => r.taskId === null)];
    return ordered.slice(0, this.capacity(entry)[kind]).some((r) => r.path === row.path);
  }

  /** An alias can arrive as a raw path segment; it names a directory here, so it must stay one segment. */
  private directoryName(entry: ProjectEntry): string {
    return entry.alias.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  }

  private async ensureWorktree(path: string, entry: ProjectEntry): Promise<void> {
    await this.createWorktreeIfMissing(path, entry);
    linkKnowledgeBase(entry.path, path);
  }

  private async createWorktreeIfMissing(path: string, entry: ProjectEntry): Promise<void> {
    if (await this.isWorktreeRoot(path)) {
      return;
    }
    rmSync(path, { recursive: true, force: true });
    // Whatever was installed went with the directory; the next prepare must install again.
    this.db.query('UPDATE cluster_worktree_slots SET lockHash = NULL WHERE path = ?').run(path);
    mkdirSync(dirname(path), { recursive: true });
    await git(entry.path, ['worktree', 'prune']);
    await git(entry.path, ['worktree', 'add', '--detach', path]);
    logger.info(`[WorktreePool] Created ${basename(dirname(path))} slot ${path}`);
  }

  private async isWorktreeRoot(path: string): Promise<boolean> {
    if (!existsSync(path)) {
      return false;
    }
    const top = await runGit(path, ['rev-parse', '--show-toplevel'], slotEnv(path));
    return top.code === 0 && top.stdout.trim() === realpathSync(path);
  }

  private async installIfLockChanged(
    project: string,
    slot: string,
    path: string,
    entry: ProjectEntry,
    logName: string,
  ): Promise<void> {
    const command = entry.install ?? DEFAULT_INSTALL[entry.type];
    if (!command) {
      return;
    }
    const lockHash = hashLockfile(path);
    const row = this.db
      .query('SELECT lockHash FROM cluster_worktree_slots WHERE project = ? AND slot = ?')
      .get(project, slot) as { lockHash: string | null } | null;
    if (row?.lockHash === lockHash) {
      return;
    }
    logger.info(`[WorktreePool] Installing dependencies in ${path}: ${command}`);
    await runLoggedCommand(command, path, join(this.config.stateDir, 'assignments', logName));
    this.db
      .query('UPDATE cluster_worktree_slots SET lockHash = ? WHERE project = ? AND slot = ?')
      .run(lockHash, project, slot);
  }
}

/**
 * The project's knowledge base is a git-ignored `_kb` symlink in its checkout; a slot is made by
 * `git worktree add`, which never carries ignored files, so it is linked here. The link is ignored
 * too, which keeps it through the `git clean -fd` that resets a slot.
 */
function linkKnowledgeBase(projectPath: string, slotPath: string): void {
  const source = join(projectPath, KNOWLEDGE_BASE_LINK);
  const target = join(slotPath, KNOWLEDGE_BASE_LINK);
  let kbTarget: string;
  try {
    if (!lstatSync(source).isSymbolicLink()) {
      return;
    }
    kbTarget = readlinkSync(source);
  } catch {
    return;
  }
  try {
    if (lstatSync(target).isSymbolicLink() && readlinkSync(target) === kbTarget) {
      return;
    }
    unlinkSync(target);
  } catch {
    // no link yet
  }
  symlinkSync(kbTarget, target);
}

const KNOWLEDGE_BASE_LINK = '_kb';

const SLOT_NAME = /^wt-[0-9a-f]{8}$/;

function newSlotName(): string {
  return `wt-${randomBytes(4).toString('hex')}`;
}

function toLease(row: SlotRow): SlotLease {
  return {
    project: row.project,
    slot: row.slot,
    kind: row.kind as SlotKind,
    path: row.path,
    taskId: row.taskId ?? '',
    leasedAt: row.leasedAt ?? '',
  };
}

/** A project without a lockfile hashes to the same value every time, so it installs once. */
function hashLockfile(path: string): string {
  const hash = createHash('sha256');
  for (const name of LOCKFILES) {
    const file = join(path, name);
    if (existsSync(file)) {
      hash.update(name).update(readFileSync(file));
    }
  }
  return hash.digest('hex');
}
