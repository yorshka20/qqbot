import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git';
import type { ContextHub } from '../hub/ContextHub';
import type { ClusterEventType, JobRecord, TaskRecord } from '../types';
import { TaskWorkspaces } from '../workspace/TaskWorkspaces';
import { WorktreePool } from '../workspace/WorktreePool';
import { commitFile, createSandbox, openClusterDb, PROJECT, type Sandbox, waitFor } from './worktreeFixtures';

const JOB_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const INTEGRATION = 'cluster/aaaaaaaa';

describe('TaskWorkspaces', () => {
  let box: Sandbox;
  let db: Database;
  let workspaces: TaskWorkspaces;
  let events: Array<{ type: ClusterEventType; taskId: string; data: Record<string, unknown> }>;
  let job: JobRecord;

  async function setUp(overrides: Parameters<typeof createSandbox>[0] = {}): Promise<void> {
    box?.cleanup();
    box = await createSandbox(overrides);
    db = openClusterDb();
    events = [];
    const hub = {
      recordTaskEvent: (type: ClusterEventType, task: TaskRecord, data: Record<string, unknown>) =>
        events.push({ type, taskId: task.id, data }),
      taskMerged: (task: TaskRecord, data: Record<string, unknown>) =>
        events.push({ type: 'task_merged', taskId: task.id, data }),
    } as unknown as ContextHub;
    workspaces = new TaskWorkspaces(box.config, hub, new WorktreePool(box.config, db, box.registry), box.registry);
    job = {
      id: JOB_ID,
      project: PROJECT,
      description: 'job',
      status: 'running',
      createdAt: new Date().toISOString(),
      taskCount: 1,
      tasksCompleted: 0,
      tasksFailed: 0,
      planning: 'interactive',
    };
  }

  function makeTask(id: string): TaskRecord {
    return {
      id: `${id}-0000-0000-0000-000000000000`,
      jobId: JOB_ID,
      project: PROJECT,
      description: 'work',
      status: 'running',
      source: 'planner',
      createdAt: new Date().toISOString(),
    };
  }

  /** A task as it stands once its worker started: leased, on its branch, in its slot. */
  async function start(id: string): Promise<{ task: TaskRecord; cwd: string }> {
    const task = makeTask(id);
    const lease = workspaces.claim(task, box.entry, 'executor');
    if (lease === 'busy' || lease === 'unpooled') throw new Error(`no slot: ${lease}`);
    const { cwd } = await workspaces.prepare(task, job, box.entry, lease);
    return { task, cwd };
  }

  async function finish(task: TaskRecord): Promise<void> {
    task.status = 'completed';
    await workspaces.settle(task, job);
  }

  beforeEach(() => setUp());
  afterEach(() => {
    db.close();
    box.cleanup();
  });

  test('a job gets an integration branch from the base, a task its own branch from that tip', async () => {
    const { task, cwd } = await start('11111111');
    expect(job.integrationBranch).toBe(INTEGRATION);
    expect(task.branch).toBe('cluster/aaaaaaaa-11111111');
    expect(task.worktreePath).toBe(cwd);
    expect(await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(task.branch as string);
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(await git(box.repo, ['rev-parse', 'master']));
  });

  test('the base branch comes from the project when it names one', async () => {
    await git(box.repo, ['branch', 'develop']);
    const developTip = await commitFile(box.repo, 'dev.txt', 'x\n', 'on master, not develop');
    expect(developTip).not.toBe(await git(box.repo, ['rev-parse', 'develop']));

    box.entry.baseBranch = 'develop';
    await start('11111111');
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(await git(box.repo, ['rev-parse', 'develop']));
  });

  test('a single finished task fast-forwards the integration branch and frees its slot', async () => {
    const { task, cwd } = await start('11111111');
    const head = await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await finish(task);

    expect(task.status).toBe('completed');
    expect(task.mergedAt).toBeDefined();
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(head);
    expect(workspaces.holdsSlot(task.id)).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['task_merged']);
  });

  test('two tasks from the same tip both land, the second with a merge commit', async () => {
    const a = await start('11111111');
    const b = await start('22222222');
    await commitFile(a.cwd, 'a.txt', 'a\n', 'task a');
    await commitFile(b.cwd, 'b.txt', 'b\n', 'task b');

    await Promise.all([finish(a.task), finish(b.task)]);

    expect(a.task.mergedAt).toBeDefined();
    expect(b.task.mergedAt).toBeDefined();
    expect((await git(box.repo, ['ls-tree', '--name-only', INTEGRATION])).split('\n')).toEqual(
      expect.arrayContaining(['a.txt', 'b.txt']),
    );
    expect(await git(box.repo, ['log', '-1', '--format=%an %s', INTEGRATION])).toContain('qqbot-cluster Merge cluster/');
    // Neither the project checkout nor master moved.
    expect(await git(box.repo, ['ls-tree', '--name-only', 'master'])).not.toContain('a.txt');
    expect(existsSync(join(box.repo, 'a.txt'))).toBe(false);
  });

  test('a later task starts from what already landed', async () => {
    const a = await start('11111111');
    await commitFile(a.cwd, 'a.txt', 'a\n', 'task a');
    await finish(a.task);

    const b = await start('22222222');
    expect(existsSync(join(b.cwd, 'a.txt'))).toBe(true);
  });

  test('a merge conflict blocks the task with the conflict in error and leaves the branches alone', async () => {
    const a = await start('11111111');
    const b = await start('22222222');
    await commitFile(a.cwd, 'shared.txt', 'one\nA\nthree\n', 'task a');
    const bHead = await commitFile(b.cwd, 'shared.txt', 'one\nB\nthree\n', 'task b');
    await finish(a.task);
    const integrationTip = await git(box.repo, ['rev-parse', INTEGRATION]);

    await finish(b.task);

    expect(b.task.status).toBe('blocked');
    expect(b.task.error).toContain('shared.txt');
    expect(b.task.mergedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(integrationTip);
    expect(await git(box.repo, ['rev-parse', b.task.branch as string])).toBe(bHead);
    expect(workspaces.holdsSlot(b.task.id)).toBe(false);
    expect(events.find((e) => e.taskId === b.task.id)?.type).toBe('task_blocked');
  });

  test('a task without commits completes without a merge', async () => {
    const { task } = await start('11111111');
    await finish(task);
    expect(task.status).toBe('completed');
    expect(task.mergedAt).toBeUndefined();
    expect(events).toEqual([]);
  });

  test('a failed task does not land, even with commits', async () => {
    const { task, cwd } = await start('11111111');
    const tip = await git(box.repo, ['rev-parse', INTEGRATION]);
    await commitFile(cwd, 'a.txt', 'a\n', 'half done');
    task.status = 'failed';
    await workspaces.settle(task, job);
    expect(task.mergedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(tip);
  });

  test('uncommitted changes are reported in the task result before the slot is reset', async () => {
    const { task, cwd } = await start('11111111');
    task.diffSummary = 'did the thing';
    await commitFile(cwd, 'a.txt', 'a\n', 'committed part');
    writeFileSync(join(cwd, 'forgotten.txt'), 'never committed\n');
    await finish(task);

    expect(task.status).toBe('completed');
    expect(task.mergedAt).toBeDefined();
    expect(task.output).toContain('?? forgotten.txt');
    expect(task.diffSummary).toContain('did the thing');
    expect(task.diffSummary).toContain('?? forgotten.txt');
    expect(existsSync(join(cwd, 'forgotten.txt'))).toBe(false);
  });

  test('settling a task that holds no slot does nothing', async () => {
    const task = makeTask('33333333');
    task.status = 'completed';
    await workspaces.settle(task, job);
    expect(task.status).toBe('completed');
    expect(events).toEqual([]);
  });

  test('publish runs on the integration content, logs next to the task, and records an event', async () => {
    await setUp({ publish: 'ls > published.txt; echo built; cp published.txt ../published-copy' });
    const { task, cwd } = await start('11111111');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await finish(task);

    await waitFor(() => events.some((e) => e.type === 'task_published'), 8000, 'publish event');
    expect(readFileSync(join(box.stateDir, 'assignments', `${task.id}.publish.log`), 'utf8')).toContain('built');
    expect(readFileSync(join(box.stateDir, 'work', PROJECT, 'published-copy'), 'utf8')).toContain('a.txt');
    // The owner can still check the branch out: nothing holds it.
    expect(await git(box.repo, ['worktree', 'list', '--porcelain'])).not.toContain(`refs/heads/${INTEGRATION}\n`);
  });

  test('a failing publish is recorded and leaves the merge in place', async () => {
    await setUp({ publish: 'echo nope; exit 7' });
    const { task, cwd } = await start('11111111');
    const head = await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await finish(task);

    await waitFor(() => events.some((e) => e.type === 'task_publish_failed'), 8000, 'publish failure event');
    expect(task.status).toBe('completed');
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(head);
    expect(String(events.find((e) => e.type === 'task_publish_failed')?.data.error)).toContain('exited with 7');
  });

  test('a merge is refused while the integration branch is checked out somewhere, and the task says where', async () => {
    const a = await start('11111111');
    await commitFile(a.cwd, 'a.txt', 'a\n', 'task a');
    await finish(a.task);
    const tip = await git(box.repo, ['rev-parse', INTEGRATION]);
    const review = join(box.repo, '..', 'review');
    await git(box.repo, ['worktree', 'add', '-q', review, INTEGRATION]);

    const b = await start('22222222');
    await commitFile(b.cwd, 'b.txt', 'b\n', 'task b');
    await finish(b.task);

    expect(b.task.status).toBe('blocked');
    expect(b.task.error).toContain('checked out in');
    expect(b.task.error).toContain('review');
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(tip);
    expect(await git(review, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(workspaces.holdsSlot(b.task.id)).toBe(false);
  });

  test('a workspace states its mode, role and branches; the words come from the prompt files', async () => {
    const { task } = await start('11111111');
    const lease = workspaces.claim(makeTask('33333333'), box.entry, 'planner');
    if (lease === 'busy' || lease === 'unpooled') throw new Error(`no planner slot: ${lease}`);
    const planner = await workspaces.prepare(makeTask('33333333'), job, box.entry, lease);

    expect(planner).toMatchObject({ mode: 'pooled', kind: 'planner', integrationBranch: INTEGRATION });
    expect(planner.branch).toMatch(/^cluster\/aaaaaaaa-33333333$/);
    expect(task.branch).toBeDefined();
    expect(workspaces.unpooled(box.entry, 'executor', job)).toEqual({
      cwd: box.repo,
      env: { CLUSTER_PLANNING: 'interactive' },
      mode: 'shared',
      kind: 'executor',
      planning: 'interactive',
    });
  });

  test('stop ends a publish that is still running instead of leaving it behind', async () => {
    await setUp({ publish: 'sleep 30' });
    const { task, cwd } = await start('11111111');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await finish(task);
    await waitFor(() => existsSync(join(box.stateDir, 'assignments', `${task.id}.publish.log`)), 8000, 'publish started');

    const started = Date.now();
    await workspaces.stop();

    expect(Date.now() - started).toBeLessThan(5000);
    await waitFor(() => events.some((e) => e.type === 'task_publish_failed'), 3000, 'publish ended');
  });
});
