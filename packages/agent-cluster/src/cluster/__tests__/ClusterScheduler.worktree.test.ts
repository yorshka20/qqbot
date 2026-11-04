import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClusterScheduler } from '../ClusterScheduler';
import { git } from '../git';
import type { ContextHub } from '../hub/ContextHub';
import type { TaskRecord, WorkerBackend } from '../types';
import { WorkerPool } from '../WorkerPool';
import { TaskWorkspaces } from '../workspace/TaskWorkspaces';
import { WorktreePool } from '../workspace/WorktreePool';
import {
  createSandbox,
  EXECUTOR,
  openClusterDb,
  PLANNER,
  PROJECT,
  removeSeedRepo,
  type Sandbox,
  waitFor,
} from './worktreeFixtures';

afterAll(removeSeedRepo);

/** Workers run the task description as a shell script, in the cwd the scheduler gave them. */
const scriptBackend: WorkerBackend = {
  name: 'claude-cli',
  async launch(config) {
    const script = config.taskPrompt.split('\n\n').at(-1) ?? '';
    return { cmd: ['sh', '-c', script], cwd: config.projectPath, env: config.env };
  },
  async verifyCredentials() {
    return { ok: true, credentialSource: 'test' };
  },
};

const commitAs = (name: string) =>
  `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=w -c user.email=w@example.invalid commit -qm ${name}`;

describe('ClusterScheduler with a worktree pool', () => {
  let box: Sandbox;
  let db: Database;
  let settled: string[];
  let lastReports: Map<string, { lastReportStatus: string; lastReportSummary: string }>;
  let cluster: { pool: WorkerPool; scheduler: ClusterScheduler };

  function startCluster(): { pool: WorkerPool; scheduler: ClusterScheduler } {
    const hub = {
      workerRegistry: {
        register: () => ({}),
        setTask: () => {},
        get: (id: string) => lastReports.get(id),
      },
      eventLog: { append: () => ({}) },
      messageBox: { send: () => 'message-id' },
      workerExited: () => {},
      taskSettled: (taskId: string) => settled.push(taskId),
      recordTaskEvent: () => {},
    } as unknown as ContextHub;
    const pool = new WorkerPool(box.config, hub);
    pool.registerBackend(scriptBackend);
    const workspaces = new TaskWorkspaces(box.config, hub, new WorktreePool(box.config, db, box.registry), box.registry);
    const scheduler = new ClusterScheduler(box.config, hub, pool, db, box.registry, workspaces);
    pool.setTaskCompletedCallback((task) => scheduler.markTaskCompleted(task));
    pool.setTaskUpdatedCallback((task) => scheduler.taskUpdated(task));
    return { pool, scheduler };
  }

  async function submitPlanner(script: string): Promise<TaskRecord> {
    const task = await cluster.scheduler.submitTask(PROJECT, script, { workerTemplate: PLANNER });
    if (!task) throw new Error('submitTask refused');
    await waitFor(() => task.status === 'running', 8000, 'planner running');
    return task;
  }

  async function spawnChild(parent: TaskRecord, script: string): Promise<TaskRecord> {
    const child = await cluster.scheduler.submitChildTask({
      parentTaskId: parent.id,
      parentJobId: parent.jobId,
      project: PROJECT,
      description: script,
      template: EXECUTOR,
    });
    if (!child) throw new Error('submitChildTask refused');
    return child;
  }

  const row = (id: string) => db.query('SELECT * FROM cluster_tasks WHERE id = ?').get(id) as Record<string, unknown>;
  const isDone = (task: TaskRecord) => cluster.scheduler.isTaskSettled(task.id);

  beforeEach(async () => {
    box = await createSandbox();
    db = openClusterDb();
    settled = [];
    lastReports = new Map();
    cluster = startCluster();
    await cluster.pool.start();
    await cluster.scheduler.start();
  });

  afterEach(async () => {
    await cluster.scheduler.stop();
    await cluster.pool.stop({ killWorkers: true });
    await cluster.scheduler.waitForSettling();
    db.close();
    box.cleanup();
  });

  test('two children run at once in different slots and both land on the integration branch', async () => {
    const planner = await submitPlanner('sleep 30');
    const gate = join(box.stateDir, 'go');
    const script = (name: string) => `while [ ! -e ${gate} ]; do sleep 0.05; done; ${commitAs(name)}`;
    const a = await spawnChild(planner, script('a'));
    const b = await spawnChild(planner, script('b'));

    await waitFor(() => a.status === 'running' && b.status === 'running', 8000, 'both children running');
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.worktreePath).not.toBe(box.repo);
    expect(planner.worktreePath).toContain('planner-1');

    await Bun.write(gate, '');
    await waitFor(() => isDone(a) && isDone(b), 8000, 'children settled');

    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(a.mergedAt).toBeDefined();
    expect(b.mergedAt).toBeDefined();
    const integration = cluster.scheduler.getJob(planner.jobId)?.integrationBranch as string;
    expect((await git(box.repo, ['ls-tree', '--name-only', integration])).split('\n')).toEqual(
      expect.arrayContaining(['a.txt', 'b.txt']),
    );
    expect(row(a.id).mergedAt).toBe(a.mergedAt as string);
    expect(row(a.id).branch).toBe(a.branch as string);
  });

  test('a child waits pending while no slot is free and starts the moment one returns', async () => {
    const planner = await submitPlanner('sleep 30');
    const gate = join(box.stateDir, 'go');
    const blockedScript = `while [ ! -e ${gate} ]; do sleep 0.05; done`;
    const first = await spawnChild(planner, blockedScript);
    const second = await spawnChild(planner, blockedScript);
    const third = await spawnChild(planner, commitAs('c'));

    expect(third.status).toBe('pending');
    await waitFor(() => first.status === 'running' && second.status === 'running', 8000, 'slots taken');
    expect(third.status).toBe('pending');

    // The scheduling interval is a minute: only the returned slot can start it in time.
    await Bun.write(gate, '');
    await waitFor(() => isDone(third), 8000, 'queued child finished');
    expect(third.status).toBe('completed');
    expect(third.mergedAt).toBeDefined();
  });

  test('a planner holding its slot never takes one from its children', async () => {
    box.entry.worktrees = 1;
    const planner = await submitPlanner('sleep 30');
    const child = await spawnChild(planner, commitAs('a'));
    await waitFor(() => isDone(child), 8000, 'child finished');
    expect(child.status).toBe('completed');
  });

  test('a report of completed waits for the exit: the slot stays leased and late commits land', async () => {
    const planner = await submitPlanner('sleep 30');
    const gate = join(box.stateDir, 'go');
    const child = await spawnChild(planner, `while [ ! -e ${gate} ]; do sleep 0.05; done; ${commitAs('late')}`);
    await waitFor(() => child.status === 'running', 8000, 'child running');

    child.status = 'completed';
    cluster.scheduler.markTaskCompleted(child);

    expect(cluster.scheduler.isTaskSettled(child.id)).toBe(false);
    expect(settled).not.toContain(child.id);
    expect(existsSync(child.worktreePath as string)).toBe(true);

    await Bun.write(gate, '');
    await waitFor(() => isDone(child), 8000, 'child settled');
    expect(settled).toContain(child.id);
    expect(child.mergedAt).toBeDefined();
  });

  test('a conflict ends the child blocked, and its waiter wakes only then', async () => {
    const planner = await submitPlanner('sleep 30');
    const edit = (text: string) =>
      `echo ${text} > shared.txt && git -c user.name=w -c user.email=w@example.invalid commit -qam ${text}`;
    const gate = join(box.stateDir, 'go');
    const a = await spawnChild(planner, `while [ ! -e ${gate} ]; do sleep 0.05; done; ${edit('A')}`);
    const b = await spawnChild(planner, `while [ ! -e ${gate} ]; do sleep 0.05; done; ${edit('B')}`);
    await waitFor(() => a.status === 'running' && b.status === 'running', 8000, 'both running');

    await Bun.write(gate, '');
    await waitFor(() => isDone(a) && isDone(b), 8000, 'both settled');

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['blocked', 'completed']);
    const loser = a.status === 'blocked' ? a : b;
    expect(loser.error).toContain('shared.txt');
    expect(row(loser.id).status).toBe('blocked');
    expect(settled).toContain(loser.id);
  });

  test('a worker that reported blocked and exits cleanly stays blocked and does not land', async () => {
    const planner = await submitPlanner('sleep 30');
    const gate = join(box.stateDir, 'go');
    const child = await spawnChild(planner, `while [ ! -e ${gate} ]; do sleep 0.05; done; ${commitAs('partial')}`);
    await waitFor(() => child.status === 'running', 8000, 'child running');
    lastReports.set(child.workerId as string, { lastReportStatus: 'blocked', lastReportSummary: 'needs a decision' });

    await Bun.write(gate, '');
    await waitFor(() => isDone(child), 8000, 'child settled');
    expect(child.status).toBe('blocked');
    expect(child.error).toBe('needs a decision');
    expect(child.mergedAt).toBeUndefined();
  });

  test('a root task with no planner lands too and completes its job', async () => {
    const task = await cluster.scheduler.submitTask(PROJECT, commitAs('solo'), { workerTemplate: EXECUTOR });
    if (!task) throw new Error('submitTask refused');
    await waitFor(() => isDone(task), 8000, 'task settled');
    const job = cluster.scheduler.getJob(task.jobId);
    expect(job?.status).toBe('completed');
    expect(await git(box.repo, ['ls-tree', '--name-only', job?.integrationBranch as string])).toContain('solo.txt');
  });

  test('a task whose workspace cannot be prepared fails, frees its slot and wakes its waiter', async () => {
    box.entry.install = 'exit 9';
    const planner = await submitPlanner('sleep 30');
    const child = await spawnChild(planner, 'true');
    await waitFor(() => isDone(child), 8000, 'child settled');
    expect(child.status).toBe('failed');
    expect(child.error).toContain('exited with 9');
    expect(settled).toContain(child.id);
  });

  test('cancelling a task mid-install lets the install finish before the slot is reset', async () => {
    const done = join(box.stateDir, 'install-finished');
    const gate = join(box.stateDir, 'go');
    const planner = await submitPlanner('sleep 30');
    box.entry.install = `while [ ! -e ${gate} ]; do sleep 0.05; done; touch ${done}`;
    const child = await spawnChild(planner, 'touch should-never-run');
    await waitFor(() => child.workerId !== undefined, 8000, 'child starting');

    await cluster.scheduler.cancelTask(child.id, 'changed my mind');
    expect(cluster.scheduler.isTaskSettled(child.id)).toBe(false);

    await Bun.write(gate, '');
    await waitFor(() => isDone(child), 8000, 'child settled');
    expect(existsSync(done)).toBe(true);
    expect(child.status).toBe('cancelled');
    expect(child.workerPid).toBeUndefined();
  });

  test('across a restart an adopted worker keeps its slot and its work still lands', async () => {
    const planner = await submitPlanner('sleep 30');
    const gate = join(box.stateDir, 'go');
    const child = await spawnChild(planner, `while [ ! -e ${gate} ]; do sleep 0.05; done; ${commitAs('survivor')}`);
    await waitFor(() => child.status === 'running', 8000, 'child running');
    const slot = child.worktreePath as string;

    await cluster.scheduler.stop();
    await cluster.pool.stop();
    cluster = startCluster();
    await cluster.pool.start();
    await cluster.scheduler.start();

    const adopted = cluster.scheduler.getActiveTask(child.id) as TaskRecord;
    expect(adopted.worktreePath).toBe(slot);
    expect(cluster.scheduler.isTaskSettled(child.id)).toBe(false);

    // An adopted worker's exit code is out of reach, so its hub_report is what says it succeeded.
    adopted.status = 'completed';
    cluster.scheduler.markTaskCompleted(adopted);
    await Bun.write(gate, '');
    await waitFor(() => isDone(adopted), 8000, 'adopted child settled');
    expect(adopted.mergedAt).toBeDefined();
    const integration = cluster.scheduler.resolveJob(planner.jobId)?.integrationBranch as string;
    expect(await git(box.repo, ['ls-tree', '--name-only', integration])).toContain('survivor.txt');
  });

  test('a restart frees the slot of a worker that is gone', async () => {
    const planner = await submitPlanner('sleep 30');
    const child = await spawnChild(planner, 'sleep 30');
    await waitFor(() => child.status === 'running', 8000, 'child running');
    const pid = child.workerPid as number;

    await cluster.scheduler.stop();
    await cluster.pool.stop();
    process.kill(-pid, 'SIGKILL');
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      8000,
      'worker dead',
    );

    cluster = startCluster();
    await cluster.pool.start();
    await cluster.scheduler.start();

    await waitFor(() => cluster.scheduler.isTaskSettled(child.id), 8000, 'slot freed');
    expect(row(child.id).status).toBe('failed');
  });

  test('a queued child keeps its place across a restart and starts once a slot returns', async () => {
    const planner = await submitPlanner('sleep 30');
    const gate = join(box.stateDir, 'go');
    const waitScript = `while [ ! -e ${gate} ]; do sleep 0.05; done`;
    const first = await spawnChild(planner, waitScript);
    const second = await spawnChild(planner, waitScript);
    const queued = await spawnChild(planner, commitAs('queued'));
    await waitFor(() => first.status === 'running' && second.status === 'running', 8000, 'slots taken');

    await cluster.scheduler.stop();
    await cluster.pool.stop();
    cluster = startCluster();
    await cluster.pool.start();
    await cluster.scheduler.start();
    expect(cluster.scheduler.getActiveTask(queued.id)?.status).toBe('pending');

    await Bun.write(gate, '');
    await waitFor(() => cluster.scheduler.isTaskSettled(queued.id), 8000, 'queued child finished');
    expect(row(queued.id).status).toBe('completed');
  });

  test('a task from before the pool keeps running in its own cwd, and its children join it there', async () => {
    const planner = await submitPlanner('sleep 30');
    planner.worktreePath = undefined;
    const child = await spawnChild(planner, 'pwd > where.txt');
    await waitFor(() => isDone(child), 8000, 'child finished');
    expect(child.worktreePath).toBeUndefined();
    expect(child.branch).toBeUndefined();
    expect(readFileSync(join(box.repo, 'where.txt'), 'utf8').trim()).toBe(box.repo);
  });

  test('a project without a pool runs in its checkout as before', async () => {
    box.entry.worktrees = 0;
    const task = await cluster.scheduler.submitTask(PROJECT, 'pwd > where.txt', { workerTemplate: EXECUTOR });
    if (!task) throw new Error('submitTask refused');
    await waitFor(() => isDone(task), 8000, 'task finished');
    expect(readFileSync(join(box.repo, 'where.txt'), 'utf8').trim()).toBe(box.repo);
    expect(task.branch).toBeUndefined();
  });
});
