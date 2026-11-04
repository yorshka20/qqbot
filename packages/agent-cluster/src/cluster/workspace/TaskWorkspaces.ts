/**
 * TaskWorkspaces — where a task's work happens and how it lands.
 *
 * A job gets an integration branch `cluster/<job>` cut from the project's base branch; each task
 * works in a leased slot on `cluster/<job>-<task>`, cut from the integration tip. The two names
 * cannot nest (`cluster/<job>/<task>`): git stores refs as paths, so a branch cannot also be a
 * directory of branches. A job ends on the base branch: when its root task finishes, the
 * integration branch lands there, and a job that cannot land has not completed.
 *
 * `git merge-tree` computes every merge without a worktree, so a conflict leaves nothing to clean
 * up. A branch no worktree holds moves by `update-ref`; one that is checked out, as the base
 * branch usually is, fast-forwards in its worktree, which also keeps that worktree's files in step.
 */

import { join } from 'node:path';
import { logger } from '@qqbot/shared';
import type { ProjectEntry, ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import type { ClusterConfig } from '../config';
import { git, runGit } from '../git';
import type { ContextHub } from '../hub/ContextHub';
import type { JobRecord, TaskRecord, WorkerWorkspace } from '../types';
import { runLoggedCommand, type SlotKind, type SlotLease, type WorktreePool } from './WorktreePool';

const MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: 'qqbot-cluster',
  GIT_AUTHOR_EMAIL: 'cluster@qqbot.local',
  GIT_COMMITTER_NAME: 'qqbot-cluster',
  GIT_COMMITTER_EMAIL: 'cluster@qqbot.local',
};

const MAX_REPORTED_FILES = 50;

type MergeOutcome =
  | { kind: 'merged'; before: string; head: string; files: string[] }
  | { kind: 'empty' }
  | { kind: 'conflict'; detail: string }
  | { kind: 'refused'; worktree: string; detail: string };

export function integrationBranchName(jobId: string): string {
  return `cluster/${jobId.slice(0, 8)}`;
}

export function taskBranchName(jobId: string, taskId: string): string {
  return `cluster/${jobId.slice(0, 8)}-${taskId.slice(0, 8)}`;
}

export class TaskWorkspaces {
  /** One merge at a time per integration branch, one publish at a time per project. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Publish commands still running, with the way to end them. */
  private readonly publishing = new Map<Promise<void>, AbortController>();

  constructor(
    private readonly config: ClusterConfig,
    private readonly hub: ContextHub,
    private readonly pool: WorktreePool,
    private readonly projects: ProjectRegistry,
  ) {}

  /** Answers the lease, `busy` when every slot is taken, or `unpooled` when the task runs in the project checkout. */
  claim(task: TaskRecord, entry: ProjectEntry, kind: SlotKind): SlotLease | 'busy' | 'unpooled' {
    if (!this.pool.isPooled(entry)) {
      return 'unpooled';
    }
    return this.pool.lease(entry, kind, task.id) ?? 'busy';
  }

  holdsSlot(taskId: string): boolean {
    return this.pool.leaseOf(taskId) !== null;
  }

  leases(): SlotLease[] {
    return this.pool.leases();
  }

  /** Give up a slot nothing was done in. */
  release(lease: SlotLease): Promise<void> {
    return this.pool.release(lease);
  }

  /** Create the job's integration branch if needed and put the task on its own branch in the slot. */
  async prepare(task: TaskRecord, job: JobRecord, entry: ProjectEntry, lease: SlotLease): Promise<WorkerWorkspace> {
    const integrationBranch = integrationBranchName(job.id);
    const baseBranch = job.baseBranch ?? entry.baseBranch ?? (await defaultBranch(entry.path));
    await this.enqueue(integrationBranch, () => this.ensureBranch(entry, integrationBranch, baseBranch));
    job.integrationBranch = integrationBranch;
    job.baseBranch = baseBranch;

    const branch = taskBranchName(job.id, task.id);
    await this.pool.prepare(lease, entry, branch, integrationBranch);
    task.branch = branch;
    task.worktreePath = lease.path;

    return {
      cwd: lease.path,
      env: {
        CLUSTER_TASK_BRANCH: branch,
        CLUSTER_INTEGRATION_BRANCH: integrationBranch,
        CLUSTER_WORKTREE: lease.path,
        CLUSTER_PLANNING: job.planning,
      },
      mode: 'pooled',
      kind: lease.kind,
      branch,
      integrationBranch,
      baseBranch,
      planning: job.planning,
    };
  }

  /** The workspace of a task that runs in the project checkout itself: no slot, no branch of its own, no merge. */
  unpooled(entry: ProjectEntry, kind: SlotKind, job: JobRecord | undefined): WorkerWorkspace {
    const planning = job?.planning ?? 'auto';
    return { cwd: entry.path, env: { CLUSTER_PLANNING: planning }, mode: 'shared', kind, planning };
  }

  /** `scheduler.landJob` after its checks: the same landing as at the end of a job, and its publish. */
  async landAgain(task: TaskRecord, job: JobRecord, entry: ProjectEntry): Promise<boolean> {
    const landed = await this.landJob(task, job, entry);
    if (landed && entry.publish) {
      void this.publish(task, job.baseBranch as string, entry, entry.publish);
    }
    return landed;
  }

  /** End the publish commands still running; a build is derived state the next merge rebuilds. */
  async stop(): Promise<void> {
    for (const controller of this.publishing.values()) {
      controller.abort();
    }
    await Promise.allSettled(this.publishing.keys());
  }

  /**
   * The worker is gone: report what it left uncommitted, land its branch if it succeeded, land
   * the job if this was its root task, and free the slot. A task whose work cannot land ends
   * `blocked`, with the reason in `error`.
   */
  async settle(task: TaskRecord, job: JobRecord | undefined): Promise<void> {
    const lease = this.pool.leaseOf(task.id);
    if (!lease) {
      return;
    }
    const entry = this.projects.resolve(task.project);
    let published: string | undefined;
    try {
      this.reportUncommitted(task, await this.pool.uncommitted(lease));
      if (task.status === 'completed' && task.branch && job?.integrationBranch && entry) {
        if (await this.land(task, job.integrationBranch, entry)) {
          published = job.integrationBranch;
        }
        if (task.status === 'completed' && !task.parentTaskId && (await this.landJob(task, job, entry))) {
          published = job.baseBranch;
        }
      }
    } catch (err) {
      logger.error(`[TaskWorkspaces] Could not land task ${task.id}:`, err);
      if (task.status === 'completed') {
        this.block(task, `Merging ${task.branch} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      await this.pool.release(lease);
    }
    if (published && entry?.publish) {
      void this.publish(task, published, entry, entry.publish);
    }
  }

  private async ensureBranch(entry: ProjectEntry, branch: string, startPoint: string): Promise<void> {
    const exists = await runGit(entry.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code === 0) {
      return;
    }
    await git(entry.path, ['branch', branch, startPoint]);
  }

  private reportUncommitted(task: TaskRecord, files: string[]): void {
    if (files.length === 0) {
      return;
    }
    const listed = files.slice(0, MAX_REPORTED_FILES).join('\n');
    const more = files.length > MAX_REPORTED_FILES ? `\n… and ${files.length - MAX_REPORTED_FILES} more` : '';
    const warning = `⚠️ Uncommitted changes were left in the worktree and are not part of the branch (the slot has been reset):\n\`\`\`\n${listed}${more}\n\`\`\``;
    task.output = task.output ? `${task.output}\n\n${warning}` : warning;
    task.diffSummary = task.diffSummary ? `${task.diffSummary}\n\n${warning}` : warning;
  }

  private async land(task: TaskRecord, integrationBranch: string, entry: ProjectEntry): Promise<boolean> {
    const branch = task.branch as string;
    const outcome = await this.enqueue(integrationBranch, () => merge(entry.path, branch, integrationBranch));
    switch (outcome.kind) {
      case 'empty':
        return false;
      case 'conflict':
        this.block(task, `Merge conflict landing ${branch} on ${integrationBranch}:\n${outcome.detail}`);
        return false;
      case 'refused':
        this.block(task, refusalReason(branch, integrationBranch, outcome));
        return false;
      case 'merged':
        task.mergedAt = new Date().toISOString();
        this.hub.taskMerged(task, {
          branch,
          integrationBranch,
          before: outcome.before,
          head: outcome.head,
          files: outcome.files,
        });
        return true;
    }
  }

  /**
   * The last step of a job: its integration branch onto the base branch. One queue per branch
   * name, because two projects can be worktrees of one repository and share the base branch.
   */
  private async landJob(task: TaskRecord, job: JobRecord, entry: ProjectEntry): Promise<boolean> {
    const from = job.integrationBranch as string;
    const onto = job.baseBranch ?? entry.baseBranch ?? (await defaultBranch(entry.path));
    job.baseBranch = onto;
    const outcome = await this.enqueue(`base:${onto}`, () => merge(entry.path, from, onto));
    switch (outcome.kind) {
      case 'empty':
        return false;
      case 'conflict':
        job.landError = `Merge conflict landing ${from} on ${onto}:\n${outcome.detail}`;
        this.block(task, job.landError);
        return false;
      case 'refused':
        job.landError = refusalReason(from, onto, outcome);
        this.block(task, job.landError);
        return false;
      case 'merged':
        job.landedAt = new Date().toISOString();
        this.hub.recordTaskEvent('job_landed', task, {
          integrationBranch: from,
          baseBranch: onto,
          before: outcome.before,
          head: outcome.head,
          files: outcome.files.slice(0, MAX_REPORTED_FILES),
          filesTotal: outcome.files.length,
        });
        return true;
    }
  }

  private block(task: TaskRecord, reason: string): void {
    task.status = 'blocked';
    task.error = reason;
    this.hub.recordTaskEvent('task_blocked', task, {
      status: 'blocked',
      summary: reason.split('\n')[0],
      detail: { blockReason: reason },
    });
  }

  /** Runs after the slot is free: a slow build must hold up neither the merge queue nor the next task. */
  private publish(task: TaskRecord, branch: string, entry: ProjectEntry, command: string): Promise<void> {
    const logName = `${task.id}.publish.log`;
    const controller = new AbortController();
    const run = this.enqueue(`publish:${entry.alias}`, async () => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        const cwd = await this.pool.preparePublish(entry, branch, logName);
        await runLoggedCommand(command, cwd, join(this.config.stateDir, 'assignments', logName), controller.signal);
        this.hub.recordTaskEvent('task_published', task, { branch, command, log: logName });
      } catch (err) {
        logger.warn(`[TaskWorkspaces] Publish failed for task ${task.id}:`, err);
        this.hub.recordTaskEvent('task_publish_failed', task, {
          branch,
          command,
          log: logName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    this.publishing.set(run, controller);
    void run.finally(() => this.publishing.delete(run));
    return run;
  }

  private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    this.queues.set(
      key,
      result.catch(() => undefined),
    );
    return result;
  }
}

/** The branch `origin/HEAD` names, else whatever the project checkout is on. */
async function defaultBranch(repo: string): Promise<string> {
  const remote = await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.code === 0) {
    return remote.stdout.trim().replace(/^origin\//, '');
  }
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

async function merge(repo: string, branch: string, target: string): Promise<MergeOutcome> {
  const ours = await git(repo, ['rev-parse', `refs/heads/${target}`]);
  const theirs = await git(repo, ['rev-parse', `refs/heads/${branch}`]);
  const ahead = await git(repo, ['rev-list', '--count', `${ours}..${theirs}`]);
  if (ahead === '0') {
    return { kind: 'empty' };
  }

  let head = theirs;
  const fastForward = await runGit(repo, ['merge-base', '--is-ancestor', ours, theirs]);
  if (fastForward.code !== 0) {
    const result = await runGit(repo, ['merge-tree', '--write-tree', '--name-only', ours, theirs]);
    if (result.code === 1) {
      return { kind: 'conflict', detail: result.stdout.split('\n').slice(1).join('\n').trim() };
    }
    if (result.code !== 0) {
      throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
    }
    const tree = result.stdout.split('\n')[0];
    head = await git(
      repo,
      ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', `Merge ${branch} into ${target}`],
      MERGE_IDENTITY,
    );
  }
  // Listed before the branch moves: a failure here must not leave a landed task marked blocked.
  const diff = await git(repo, ['diff', '--name-only', '--no-renames', '-z', ours, head]);
  // `update-ref` would move a checked-out branch under its worktree's index and files. `head`
  // descends from `ours`, so `--ff-only` is the same move made through that worktree; git refuses
  // it, and changes nothing, when uncommitted work there overlaps the merge.
  const worktree = await worktreeHolding(repo, target);
  if (worktree) {
    const moved = await runGit(worktree, ['merge', '--ff-only', head]);
    if (moved.code !== 0) {
      return { kind: 'refused', worktree, detail: (moved.stderr || moved.stdout).trim() };
    }
  } else {
    await git(repo, ['update-ref', `refs/heads/${target}`, head, ours]);
  }
  return { kind: 'merged', before: ours, head, files: diff.split('\0').filter(Boolean) };
}

function refusalReason(from: string, onto: string, refused: { worktree: string; detail: string }): string {
  return `Cannot land ${from} on ${onto}: the checkout in ${refused.worktree} refused it.\n${refused.detail}`;
}

/** The worktree that has `branch` checked out, if any (`git worktree list --porcelain` blocks). */
async function worktreeHolding(repo: string, branch: string): Promise<string | null> {
  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  for (const block of list.split('\n\n')) {
    if (block.split('\n').includes(`branch refs/heads/${branch}`)) {
      return block.match(/^worktree (.+)$/m)?.[1] ?? repo;
    }
  }
  return null;
}
