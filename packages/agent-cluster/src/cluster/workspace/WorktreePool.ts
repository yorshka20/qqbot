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
 * The project checkout is never a slot.
 */

import type { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logger } from '@qqbot/shared';
import type { ProjectEntry, ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import type { ClusterConfig } from '../config';
import { git, runGit } from '../git';
import type { WorktreePoolStatus } from '../types';

export type SlotKind = 'executor' | 'planner';

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

const PUBLISH_SLOT = 'publish';
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const DEFAULT_INSTALL: Partial<Record<ProjectEntry['type'], string>> = { bun: 'bun install', node: 'npm install' };

/**
 * Run a shell command with its output on `logPath`, ending it if it outlives the timeout.
 * Throws on failure with the tail of the log, which is what a person needs to see.
 */
export async function runLoggedCommand(command: string, cwd: string, logPath: string): Promise<void> {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, { cwd, shell: true, stdio: ['ignore', log, log], windowsHide: true });
      const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
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
 * Git environment for commands run inside a slot. `<stateDir>` usually sits inside a project
 * checkout, so in a slot that lost its `.git` file, git would walk up and act on that checkout.
 * The ceiling makes it fail instead: `checkout -f` must never reach the main checkout.
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

  private get workRoot(): string {
    return join(this.config.stateDir, 'work');
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

  /** Take the lowest free slot of this kind, or null when all are leased. Synchronous, so two dispatches cannot pick the same one. */
  lease(entry: ProjectEntry, kind: SlotKind, taskId: string): SlotLease | null {
    const project = this.directoryName(entry);
    const leased = new Set(
      (
        this.db
          .query('SELECT slot FROM cluster_worktree_slots WHERE project = ? AND taskId IS NOT NULL')
          .all(project) as Array<{
          slot: string;
        }>
      ).map((row) => row.slot),
    );
    const slot = this.slotNames(entry, kind).find((name) => !leased.has(name));
    if (!slot) {
      return null;
    }
    const lease: SlotLease = {
      project,
      slot,
      kind,
      path: join(this.workRoot, project, slot),
      taskId,
      leasedAt: new Date().toISOString(),
    };
    this.db
      .query(
        `INSERT INTO cluster_worktree_slots (project, slot, kind, path, taskId, leasedAt) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project, slot) DO UPDATE SET kind = excluded.kind, path = excluded.path, taskId = excluded.taskId, leasedAt = excluded.leasedAt`,
      )
      .run(project, slot, kind, lease.path, taskId, lease.leasedAt);
    return lease;
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
    const path = join(this.workRoot, project, PUBLISH_SLOT);
    await this.ensureWorktree(path, entry);
    await git(path, ['checkout', '-f', '--detach', rev], slotEnv(path));
    await git(path, ['clean', '-fd'], slotEnv(path));
    this.db
      .query(
        `INSERT INTO cluster_worktree_slots (project, slot, kind, path) VALUES (?, ?, 'publish', ?)
         ON CONFLICT (project, slot) DO NOTHING`,
      )
      .run(project, PUBLISH_SLOT, path);
    await this.installIfLockChanged(project, PUBLISH_SLOT, path, entry, logName);
    return path;
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
   * Remove every directory under `<stateDir>/work` the pool does not claim: a slot beyond the
   * configured size, or anything of a project no longer registered. A leased slot is always
   * claimed. Answers the removed paths; `dryRun` only lists them.
   */
  async gc(options?: { dryRun?: boolean }): Promise<string[]> {
    if (!existsSync(this.workRoot)) {
      return [];
    }
    const entries = new Map(this.projects.list().map((entry) => [this.directoryName(entry), entry]));
    const claimed = new Set(this.leases().map((lease) => lease.path));
    for (const [project, entry] of entries) {
      for (const name of this.allSlotNames(entry)) {
        claimed.add(join(this.workRoot, project, name));
      }
    }

    const removed: string[] = [];
    for (const project of readdirSync(this.workRoot)) {
      const projectDir = join(this.workRoot, project);
      const entry = entries.get(project);
      for (const name of readdirSync(projectDir)) {
        const path = join(projectDir, name);
        if (claimed.has(path)) {
          continue;
        }
        removed.push(path);
        if (options?.dryRun) {
          continue;
        }
        if (entry) {
          await runGit(entry.path, ['worktree', 'remove', '--force', path]);
        }
        rmSync(path, { recursive: true, force: true });
        this.db.query('DELETE FROM cluster_worktree_slots WHERE project = ? AND slot = ?').run(project, name);
      }
      if (options?.dryRun) {
        continue;
      }
      if (entry) {
        await runGit(entry.path, ['worktree', 'prune']);
      }
      if (readdirSync(projectDir).length === 0) {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }
    return removed;
  }

  private slotNames(entry: ProjectEntry, kind: SlotKind): string[] {
    const count = this.capacity(entry)[kind];
    return Array.from({ length: count }, (_, i) => (kind === 'planner' ? `planner-${i + 1}` : String(i + 1)));
  }

  private allSlotNames(entry: ProjectEntry): string[] {
    return [
      ...this.slotNames(entry, 'executor'),
      ...this.slotNames(entry, 'planner'),
      ...(entry.publish ? [PUBLISH_SLOT] : []),
    ];
  }

  /** An alias can arrive as a raw path segment; it names a directory here, so it must stay one segment. */
  private directoryName(entry: ProjectEntry): string {
    return entry.alias.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  }

  private async ensureWorktree(path: string, entry: ProjectEntry): Promise<void> {
    if (await this.isWorktreeRoot(path)) {
      return;
    }
    rmSync(path, { recursive: true, force: true });
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
