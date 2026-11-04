import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git';
import type { ContextHub } from '../hub/ContextHub';
import type { ClusterEventType, JobRecord, TaskRecord } from '../types';
import { TaskWorkspaces } from '../workspace/TaskWorkspaces';
import { WorktreePool } from '../workspace/WorktreePool';
import {
  commitFile,
  createSandbox,
  openClusterDb,
  PROJECT,
  removeSeedRepo,
  type Sandbox,
  waitFor,
} from './worktreeFixtures';

afterAll(removeSeedRepo);

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

  function makeTask(id: string, parentTaskId: string | undefined = 'planner-task'): TaskRecord {
    return {
      id: `${id}-0000-0000-0000-000000000000`,
      jobId: JOB_ID,
      parentTaskId,
      project: PROJECT,
      description: 'work',
      status: 'running',
      source: 'planner',
      createdAt: new Date().toISOString(),
    };
  }

  /** A task as it stands once its worker started: leased, on its branch, in its slot. */
  async function start(id: string, parentTaskId?: string): Promise<{ task: TaskRecord; cwd: string }> {
    const task = makeTask(id, parentTaskId);
    const lease = workspaces.claim(task, box.entry, 'executor');
    if (lease === 'busy' || lease === 'unpooled') throw new Error(`no slot: ${lease}`);
    const { cwd } = await workspaces.prepare(task, job, box.entry, lease);
    return { task, cwd };
  }

  /** The job's root task: finishing it is what lands the job. */
  async function startRoot(id: string): Promise<{ task: TaskRecord; cwd: string }> {
    const task = makeTask(id, '');
    delete task.parentTaskId;
    const lease = workspaces.claim(task, box.entry, 'executor');
    if (lease === 'busy' || lease === 'unpooled') throw new Error(`no slot: ${lease}`);
    const { cwd } = await workspaces.prepare(task, job, box.entry, lease);
    return { task, cwd };
  }

  async function finish(task: TaskRecord): Promise<void> {
    task.status = 'completed';
    await workspaces.settle(task, job, () => []);
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
    await workspaces.settle(task, job, () => []);
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
    await workspaces.settle(task, job, () => []);
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
    expect(readFileSync(join(box.worktreeRoot, PROJECT, 'published-copy'), 'utf8')).toContain('a.txt');
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

  test('an integration branch checked out somewhere moves in that worktree, files included', async () => {
    const { task, cwd } = await start('11111111');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    const owner = join(box.stateDir, 'owner-checkout');
    await git(box.repo, ['worktree', 'add', '-q', owner, INTEGRATION]);

    await finish(task);

    expect(task.status).toBe('completed');
    expect(readFileSync(join(owner, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await git(owner, ['status', '--porcelain'])).toBe('');
  });

  test('uncommitted work in that worktree stops the merge and is left as it was', async () => {
    const { task, cwd } = await start('11111111');
    await commitFile(cwd, 'shared.txt', 'theirs\n', 'task a');
    const owner = join(box.stateDir, 'owner-checkout');
    await git(box.repo, ['worktree', 'add', '-q', owner, INTEGRATION]);
    writeFileSync(join(owner, 'shared.txt'), 'owner is editing this\n');
    const tip = await git(box.repo, ['rev-parse', INTEGRATION]);

    await finish(task);

    expect(task.status).toBe('blocked');
    expect(task.error).toContain(owner);
    expect(task.mergedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).toBe(tip);
    expect(readFileSync(join(owner, 'shared.txt'), 'utf8')).toBe('owner is editing this\n');
  });

  test('a child stops at the integration branch; the base branch waits for the job', async () => {
    const base = await git(box.repo, ['rev-parse', 'master']);
    const { task, cwd } = await start('11111111');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await finish(task);

    expect(task.mergedAt).toBeDefined();
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(base);
    expect(job.landedAt).toBeUndefined();
  });

  test('the root task lands the job on the base branch, in the checkout that holds it', async () => {
    const child = await start('11111111');
    await commitFile(child.cwd, 'a.txt', 'a\n', 'task a');
    await finish(child.task);
    const root = await startRoot('22222222');

    await finish(root.task);

    expect(root.task.status).toBe('completed');
    expect(job.landedAt).toBeDefined();
    expect(job.baseBranch).toBe('master');
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(await git(box.repo, ['rev-parse', INTEGRATION]));
    expect(readFileSync(join(box.repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await git(box.repo, ['status', '--porcelain'])).toBe('');
    expect(events.at(-1)).toMatchObject({
      type: 'job_landed',
      taskId: root.task.id,
      data: { integrationBranch: INTEGRATION, baseBranch: 'master', files: ['a.txt'], filesTotal: 1 },
    });
  });

  test('a job with nothing to land completes without touching the base branch', async () => {
    const base = await git(box.repo, ['rev-parse', 'master']);
    const { task } = await startRoot('22222222');
    await finish(task);

    expect(task.status).toBe('completed');
    expect(job.landedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(base);
  });

  test('a base branch that moved on gets a merge commit', async () => {
    const { task, cwd } = await startRoot('22222222');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await commitFile(box.repo, 'b.txt', 'b\n', 'someone else');

    await finish(task);

    expect(task.status).toBe('completed');
    expect(job.landedAt).toBeDefined();
    expect(readFileSync(join(box.repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(box.repo, 'b.txt'), 'utf8')).toBe('b\n');
  });

  test('a job that cannot land has not completed: the root task ends blocked with the conflict', async () => {
    const { task, cwd } = await startRoot('22222222');
    await commitFile(cwd, 'shared.txt', 'ours\n', 'task a');
    const moved = await commitFile(box.repo, 'shared.txt', 'theirs\n', 'someone else');

    await finish(task);

    expect(task.status).toBe('blocked');
    expect(task.error).toContain('shared.txt');
    expect(job.landedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(moved);
    expect(events.at(-1)?.type).toBe('task_blocked');
  });

  test('a failed root task leaves the base branch alone', async () => {
    const base = await git(box.repo, ['rev-parse', 'master']);
    const child = await start('11111111');
    await commitFile(child.cwd, 'a.txt', 'a\n', 'task a');
    await finish(child.task);
    const root = await startRoot('22222222');

    root.task.status = 'failed';
    await workspaces.settle(root.task, job, () => []);

    expect(job.landedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(base);
  });

  test('a root task does not land the job while another task of the job has not ended', async () => {
    const base = await git(box.repo, ['rev-parse', 'master']);
    const child = await start('11111111');
    await commitFile(child.cwd, 'a.txt', 'a\n', 'task a');
    await finish(child.task);
    const root = await startRoot('22222222');
    root.task.status = 'completed';

    await workspaces.settle(root.task, job, () => ['33333333-0000-0000-0000-000000000000']);

    expect(root.task.status as string).toBe('blocked');
    expect(root.task.error).toContain('33333333');
    expect(job.landedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(base);
    expect(await git(box.repo, ['rev-parse', INTEGRATION])).not.toBe(base);
  });

  test('a rebase of the base branch in its checkout stops the landing and is left alone', async () => {
    const { task, cwd } = await startRoot('22222222');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    const base = await git(box.repo, ['rev-parse', 'master']);
    await git(box.repo, ['checkout', '-q', '--detach']);
    const rebase = join(await git(box.repo, ['rev-parse', '--absolute-git-dir']), 'rebase-merge');
    mkdirSync(rebase, { recursive: true });
    writeFileSync(join(rebase, 'head-name'), 'refs/heads/master\n');

    await finish(task);

    expect(task.status).toBe('blocked');
    expect(task.error).toContain('rebase');
    expect(job.landedAt).toBeUndefined();
    expect(await git(box.repo, ['rev-parse', 'master'])).toBe(base);
    rmSync(rebase, { recursive: true, force: true });
  });

  test('publish runs again on the base branch once the job landed', async () => {
    await setUp({ publish: 'git rev-parse HEAD >> ../published-revs' });
    const { task, cwd } = await startRoot('22222222');
    await commitFile(cwd, 'a.txt', 'a\n', 'task a');
    await commitFile(box.repo, 'b.txt', 'b\n', 'someone else');
    await finish(task);

    await waitFor(() => events.some((e) => e.type === 'task_published'), 8000, 'publish event');
    expect(events.find((e) => e.type === 'task_published')?.data.branch).toBe('master');
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
