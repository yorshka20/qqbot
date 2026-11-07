import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClusterScheduler } from '../ClusterScheduler';
import { ContextHub } from '../hub/ContextHub';
import type { HubSubscribeInput, TaskRecord, WorkerBackend } from '../types';
import { WorkerPool } from '../WorkerPool';
import { TaskWorkspaces } from '../workspace/TaskWorkspaces';
import { WorktreePool } from '../workspace/WorktreePool';
import { createSandbox, EXECUTOR, openClusterDb, PLANNER, PROJECT, type Sandbox, waitFor } from './worktreeFixtures';

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
  `mkdir -p src && echo ${name} > src/${name}.txt && git add src && git -c user.name=w -c user.email=w@example.invalid commit -qm ${name}`;

describe('subscriptions against a real scheduler and real merges', () => {
  let box: Sandbox;
  let db: Database;
  let cluster: { hub: ContextHub; pool: WorkerPool; scheduler: ClusterScheduler };
  let gate: string;

  function startCluster(): typeof cluster {
    const hub = new ContextHub(box.config, db, join(box.stateDir, 'tickets'));
    const pool = new WorkerPool(box.config, hub);
    pool.registerBackend(scriptBackend);
    const workspaces = new TaskWorkspaces(box.config, hub, new WorktreePool(box.config, db, box.registry), box.registry);
    const scheduler = new ClusterScheduler(box.config, hub, pool, db, box.registry, workspaces);
    pool.setTaskCompletedCallback((task) => scheduler.markTaskCompleted(task));
    pool.setTaskUpdatedCallback((task) => scheduler.taskUpdated(task));
    hub.setSchedulerBridge({
      submitChildTask: (opts) => scheduler.submitChildTask(opts),
      findTask: (taskId) => scheduler.findTask(taskId),
      isTaskSettled: (taskId) => scheduler.isTaskSettled(taskId),
      taskInboxed: (taskId, type) => scheduler.taskInboxed(taskId, type),
      routeMessage: (task) => scheduler.routeMessage(task),
    });
    return { hub, pool, scheduler };
  }

  async function submitPlanner(): Promise<TaskRecord> {
    const task = await cluster.scheduler.submitTask(PROJECT, 'sleep 30', { workerTemplate: PLANNER });
    if (!task) throw new Error('submitTask refused');
    await waitFor(() => task.status === 'running', 8000, 'planner running');
    return task;
  }

  /** Goes through `hub_spawn` as a planner would. */
  async function spawn(planner: TaskRecord, script: string, subscribe?: HubSubscribeInput): Promise<TaskRecord> {
    const { childTaskId } = await cluster.hub.handleSpawn(planner.workerId as string, {
      description: script,
      template: EXECUTOR,
      subscribe,
    });
    return cluster.scheduler.findTask(childTaskId) as TaskRecord;
  }

  const waitForGate = () => `while [ ! -e ${gate} ]; do sleep 0.05; done`;
  const open = () => Bun.write(gate, '');
  const settledTask = (task: TaskRecord) => () => cluster.scheduler.isTaskSettled(task.id);

  beforeEach(async () => {
    box = await createSandbox();
    db = openClusterDb();
    gate = join(box.stateDir, 'go');
    cluster = startCluster();
    await cluster.pool.start();
    await cluster.scheduler.start();
  });

  afterEach(async () => {
    await cluster.scheduler.stop();
    await cluster.pool.stop({ killWorkers: true });
    await cluster.scheduler.waitForSettling();
    cluster.hub.lockManager.stop();
    db.close();
    box.cleanup();
  });

  test('a merge wakes a subscribed sibling with the files that landed', async () => {
    const planner = await submitPlanner();
    const a = await spawn(planner, `${waitForGate()}; ${commitAs('a')}`);
    const b = await spawn(planner, 'sleep 30');
    await waitFor(() => a.status === 'running' && b.status === 'running', 8000, 'both running');
    cluster.hub.handleSubscribe(b.workerId as string, { tasks: [a.id] });

    const waiting = cluster.hub.handleWait(b.workerId as string, { timeoutMs: 8_000 });
    await open();
    const result = await waiting;

    expect(result.reason).toBe('event');
    const integration = cluster.scheduler.resolveJob(planner.jobId)?.integrationBranch;
    expect(result.updates).toMatchObject([
      { kind: 'task_merged', taskId: a.id, branch: integration, files: ['src/a.txt'] },
    ]);

    await waitFor(settledTask(a), 8000, 'a settled');
    expect(cluster.hub.messageBox.consume(b.workerId as string)).toMatchObject([
      { kind: 'task_completed', taskId: a.id },
    ]);
  });

  test('a file subscriber spawned beside the task runs at once and hears of the merge that touched its file', async () => {
    const planner = await submitPlanner();
    const a = await spawn(planner, `${waitForGate()}; ${commitAs('a')}`);
    const follower = await spawn(planner, 'sleep 30', { files: ['src/*.txt'] });
    await waitFor(() => follower.status === 'running', 8000, 'follower running');

    await open();
    await waitFor(settledTask(a), 8000, 'a settled');

    expect(cluster.hub.messageBox.consume(follower.workerId as string)).toMatchObject([
      { kind: 'files_changed', taskId: a.id, files: ['src/a.txt'] },
    ]);
  });

  test('hub_spawn holds a dependent child until its dependency lands, then tells it what landed', async () => {
    const planner = await submitPlanner();
    const a = await spawn(planner, `${waitForGate()}; ${commitAs('a')}`);
    const b = await spawn(planner, 'test -e src/a.txt && sleep 30', { tasks: [a.id] });

    await waitFor(() => a.status === 'running', 8000, 'a running');
    expect(b.status).toBe('pending');
    expect(b.workerId).toBeUndefined();
    expect(cluster.hub.subscriptions.of(b.id)).toEqual({
      tasks: [a.id],
      files: [],
      branch: false,
      dependsOn: [a.id],
    });

    await open();
    await waitFor(() => b.status === 'running', 8000, 'b running');

    expect(existsSync(join(b.worktreePath as string, 'src/a.txt'))).toBe(true);
    expect(cluster.hub.messageBox.consume(b.workerId as string)).toMatchObject([
      { kind: 'task_merged', taskId: a.id, files: ['src/a.txt'] },
      { kind: 'task_completed', taskId: a.id },
    ]);
  });

  test('a dependency that already landed lets the child start at once and still says what landed', async () => {
    const planner = await submitPlanner();
    await open();
    const a = await spawn(planner, commitAs('a'));
    await waitFor(settledTask(a), 8000, 'a settled');

    const b = await spawn(planner, 'sleep 30', { tasks: [a.id] });
    await waitFor(() => b.status === 'running', 8000, 'b running');

    expect(cluster.hub.messageBox.consume(b.workerId as string)).toMatchObject([
      { kind: 'task_merged', taskId: a.id },
      { kind: 'task_completed', taskId: a.id },
    ]);
  });

  test('a failed dependency cancels the child and wakes the planner, along the whole chain', async () => {
    const planner = await submitPlanner();
    const a = await spawn(planner, `${waitForGate()}; exit 3`);
    const b = await spawn(planner, 'sleep 30', { tasks: [a.id] });
    const c = await spawn(planner, 'sleep 30', { tasks: [b.id] });

    const planning = cluster.hub.handleWait(planner.workerId as string, { tasks: [c.id], timeoutMs: 8_000 });
    await open();
    const result = await planning;

    // The planner hears of a's failure as an event before c, the task it watches, is cancelled.
    expect(['task', 'event']).toContain(result.reason);
    await waitFor(() => c.status === 'cancelled', 8000, 'c cancelled');
    expect(a.status).toBe('failed');
    expect(b.status).toBe('cancelled');
    expect(b.error).toContain(`dependency ${a.id} ended failed`);
    expect(c.status).toBe('cancelled');
    expect(c.error).toContain(`dependency ${b.id} ended cancelled`);
    expect(b.workerId).toBeUndefined();
    expect(cluster.hub.subscriptions.of(b.id).tasks).toEqual([]);
  });

  test('a waiting child keeps waiting across a restart and starts once its dependency lands', async () => {
    const planner = await submitPlanner();
    const a = await spawn(planner, `${waitForGate()}; ${commitAs('a')}`);
    const b = await spawn(planner, 'sleep 30', { tasks: [a.id] });
    await waitFor(() => a.status === 'running', 8000, 'a running');

    await cluster.scheduler.stop();
    await cluster.pool.stop();
    cluster.hub.lockManager.stop();
    cluster = startCluster();
    await cluster.pool.start();
    await cluster.scheduler.start();

    const waiting = cluster.scheduler.getActiveTask(b.id) as TaskRecord;
    expect(waiting.status).toBe('pending');

    // An adopted worker's exit code is out of reach, so its hub_report is what says it succeeded.
    const adopted = cluster.scheduler.getActiveTask(a.id) as TaskRecord;
    adopted.status = 'completed';
    cluster.scheduler.markTaskCompleted(adopted);
    await open();

    await waitFor(() => waiting.status === 'running', 8000, 'b running');
    expect(existsSync(join(waiting.worktreePath as string, 'src/a.txt'))).toBe(true);
  });
});
