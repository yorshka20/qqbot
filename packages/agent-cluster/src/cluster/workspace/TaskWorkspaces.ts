/**
 * TaskWorkspaces — where a task's work happens and how it lands.
 *
 * A job gets an integration branch `cluster/<job>` cut from the project's base branch; each task
 * works in a leased slot on `cluster/<job>-<task>`, cut from the integration tip. The two names
 * cannot nest (`cluster/<job>/<task>`): git stores refs as paths, so a branch cannot also be a
 * directory of branches.
 *
 * Merging never touches a worktree: `git merge-tree` computes the result and `update-ref` moves
 * the branch. So no worktree has to hold the integration branch, which leaves the owner free to
 * check it out, and a conflict leaves nothing to clean up.
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
  | { kind: 'merged'; head: string }
  | { kind: 'empty' }
  | { kind: 'conflict'; detail: string }
  | { kind: 'checkedOut'; worktree: string };

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
    await this.enqueue(integrationBranch, () => this.ensureBranch(entry, integrationBranch));
    job.integrationBranch = integrationBranch;

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
      planning: job.planning,
    };
  }

  /** The workspace of a task that runs in the project checkout itself: no slot, no branch of its own, no merge. */
  unpooled(entry: ProjectEntry, kind: SlotKind, job: JobRecord | undefined): WorkerWorkspace {
    const planning = job?.planning ?? 'auto';
    return { cwd: entry.path, env: { CLUSTER_PLANNING: planning }, mode: 'shared', kind, planning };
  }

  /** End the publish commands still running; a build is derived state the next merge rebuilds. */
  async stop(): Promise<void> {
    for (const controller of this.publishing.values()) {
      controller.abort();
    }
    await Promise.allSettled(this.publishing.keys());
  }

  /**
   * The worker is gone: report what it left uncommitted, land its branch if it succeeded, and
   * free the slot. A task whose branch cannot land ends `blocked`, with the reason in `error`.
   */
  async settle(task: TaskRecord, job: JobRecord | undefined): Promise<void> {
    const lease = this.pool.leaseOf(task.id);
    if (!lease) {
      return;
    }
    const entry = this.projects.resolve(task.project);
    let merged = false;
    try {
      this.reportUncommitted(task, await this.pool.uncommitted(lease));
      if (task.status === 'completed' && task.branch && job?.integrationBranch && entry) {
        merged = await this.land(task, job.integrationBranch, entry);
      }
    } catch (err) {
      logger.error(`[TaskWorkspaces] Could not land task ${task.id}:`, err);
      if (task.status === 'completed') {
        this.block(task, `Merging ${task.branch} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      await this.pool.release(lease);
    }
    if (merged && entry?.publish && job?.integrationBranch) {
      void this.publish(task, job.integrationBranch, entry, entry.publish);
    }
  }

  private async ensureBranch(entry: ProjectEntry, branch: string): Promise<void> {
    const exists = await runGit(entry.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code === 0) {
      return;
    }
    await git(entry.path, ['branch', branch, entry.baseBranch ?? (await defaultBranch(entry.path))]);
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
      case 'checkedOut':
        this.block(
          task,
          `Cannot land ${branch}: ${integrationBranch} is checked out in ${outcome.worktree}. ` +
            'The daemon moves that branch, so review it detached (`git switch --detach <branch>`) and retry the task.',
        );
        return false;
      case 'merged':
        task.mergedAt = new Date().toISOString();
        this.hub.recordTaskEvent('task_merged', task, { branch, integrationBranch, head: outcome.head });
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
  private publish(task: TaskRecord, integrationBranch: string, entry: ProjectEntry, command: string): Promise<void> {
    const logName = `${task.id}.publish.log`;
    const controller = new AbortController();
    const run = this.enqueue(`publish:${entry.alias}`, async () => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        const cwd = await this.pool.preparePublish(entry, integrationBranch, logName);
        await runLoggedCommand(command, cwd, join(this.config.stateDir, 'assignments', logName), controller.signal);
        this.hub.recordTaskEvent('task_published', task, { integrationBranch, command, log: logName });
      } catch (err) {
        logger.warn(`[TaskWorkspaces] Publish failed for task ${task.id}:`, err);
        this.hub.recordTaskEvent('task_publish_failed', task, {
          integrationBranch,
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
  // `update-ref` would move the branch under that worktree's index and working tree.
  const worktree = await worktreeHolding(repo, target);
  if (worktree) {
    return { kind: 'checkedOut', worktree };
  }
  await git(repo, ['update-ref', `refs/heads/${target}`, head, ours]);
  return { kind: 'merged', head };
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
