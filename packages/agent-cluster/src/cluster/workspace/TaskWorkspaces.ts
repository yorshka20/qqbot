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
      },
      promptNote: pooledNote(lease.kind, lease.path, branch, integrationBranch),
    };
  }

  /** The workspace of a task that runs in the project checkout itself: no slot, no branch of its own, no merge. */
  unpooled(entry: ProjectEntry, kind: SlotKind): WorkerWorkspace {
    return { cwd: entry.path, env: {}, promptNote: unpooledNote(kind, entry.path) };
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

function pooledNote(kind: SlotKind, path: string, branch: string, integrationBranch: string): string {
  const shared = [
    '## 本任务的工作区',
    '',
    `- 工作目录：\`${path}\`（你启动时的 cwd，只属于你的 git worktree）`,
    `- 你的分支：\`${branch}\`，从集成分支当时的最新提交切出`,
    `- 本 job 的集成分支：\`${integrationBranch}\``,
    '',
  ];
  if (kind === 'planner') {
    return [
      ...shared,
      '每个 executor 跑在自己的 worktree、自己的分支上，互相隔离：不共用 git index，看不到彼此的半成品，不会互相触发 pre-commit。',
      '所以**互相独立的子任务要并行 spawn**，不要因为"同一个仓库"就串行；只有真实的数据依赖才串行，写进 plan 的 `depends_on`。',
      '',
      '- child 成功退出后 daemon 立刻把它的分支合入集成分支，owner 在集成分支上验收，不用等整个 job 结束。',
      '- 后 spawn 的 child 从集成分支当时的最新提交开始：依赖 A 的 B 等 A 结束后再 spawn，它一启动就能看到 A 的改动。',
      '- 并行的 child 改同一个文件时，后合入的那个会以 `blocked` 结束；拆分时让并行的 child 不碰同一批文件。',
      '- `hub_wait` / `hub_query_task` 返回的 `mergedAt` 有值说明已合入；`completed` 却没有 `mergedAt` 说明它没提交任何东西。',
      '- 槽位满时 `hub_spawn` 返回 `queued`，有槽位归还时自动启动，你照常 `hub_wait`。',
      '- 你的 worktree 不装依赖，也**不会**随 child 合入而更新。看 child 的成果用 `git log <集成分支>` /',
      '  `git diff <集成分支>~1 <集成分支>` / `git show <集成分支>:<路径>`，不要切分支。',
      '',
      '**交付门**（`hub_report(completed)` 之前）：每个该有改动的 child 都有 `mergedAt`；没有 child 停在 `blocked`；',
      '结果里没有"未提交改动"的警告（daemon 把它写在 child 的 `diffSummary` 末尾，那些改动已随槽位重置丢失）；',
      '`git log --oneline <集成分支>` 里能看到这些 commit，把集成分支名和每个 child 的 commit hash 写进最终 summary。',
    ].join('\n');
  }
  return [
    ...shared,
    '同一项目的其他 executor 可能正在各自的 worktree 里并行工作，你看不到他们没提交的改动，他们也看不到你的。',
    '',
    '- **所有改动都在 cwd 里做，提交到当前分支。** 不切换分支，不碰别的 worktree，不去项目主检出里改东西。',
    '- **不要 `git push`，不要自己合并到集成分支或主分支。** 你退出后 daemon 会把你的分支合入集成分支；只合入已提交的内容。',
    '- **没提交的改动会丢。** 你退出后这个 worktree 会被重置交给下一个任务；daemon 在结果里报出没提交的文件，但内容不保留。',
    '- 依赖已经装好（`node_modules` 在这份 worktree 里复用），不需要自己安装，除非你改了 lockfile。',
    '- 要看已合入的内容用 `git show <集成分支>:<路径>` / `git log <集成分支>`，不离开当前分支。',
  ].join('\n');
}

function unpooledNote(kind: SlotKind, path: string): string {
  const shared = [
    '## 本任务的工作区',
    '',
    `- 工作目录：\`${path}\`，这是项目的检出本身，**不是**专属 worktree；同项目的其他 worker 可能在同一目录里工作。`,
    '- 没有集成分支，daemon 不会替你合并。',
    '',
  ];
  if (kind === 'planner') {
    return [
      ...shared,
      'child 共用这份检出：两个 child 同时改文件会互相踩到 git index 和半成品，所以有共同文件的子任务要**串行** spawn，并靠 `hub_claim` 锁文件。',
      '',
      '**交付门**（`hub_report(completed)` 之前）：在检出里跑 `git status -s` 必须洁净；每个 child 报告的 commit 在 `git log` 里能看到；',
      '把每个 child 的 commit hash 写进最终 summary。有 child 没交付就 spawn 一个补刀 executor，不要自己 commit。',
    ].join('\n');
  }
  return [
    ...shared,
    '- 改动提交到检出当前所在的分支；不切分支，不要 `git push`，owner 直接在这份检出里验收。',
    '- 改文件前 `hub_claim`：别的 worker 可能同时在这里工作。',
  ].join('\n');
}
