import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClusterScheduler } from '../ClusterScheduler';
import { git } from '../git';
import { ContextHub } from '../hub/ContextHub';
import type { TaskRecord, WorkerBackend, WorkerResumeConfig, WorkerSpawnConfig } from '../types';
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

/**
 * Workers run the last paragraph of their prompt as a shell script. A resumed worker runs the
 * script stored for its session under `resumeScripts`, and the prompt it was given is recorded.
 */
const launches: WorkerSpawnConfig[] = [];
const resumes: WorkerResumeConfig[] = [];
const resumeScripts = new Map<string, string>();

const scriptBackend: WorkerBackend = {
  name: 'claude-cli',
  async launch(config) {
    launches.push(config);
    const script = config.taskPrompt.split('\n\n').at(-1) ?? '';
    return { cmd: ['sh', '-c', script], cwd: config.projectPath, env: config.env, sessionId: `session-${config.workerId}` };
  },
  async resume(config) {
    resumes.push(config);
    const script = resumeScripts.get(config.sessionId) ?? 'true';
    return { cmd: ['sh', '-c', script], cwd: config.projectPath, env: config.env, sessionId: config.sessionId };
  },
  async verifyCredentials() {
    return { ok: true, credentialSource: 'test' };
  },
};

const commitAs = (name: string) =>
  `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=w -c user.email=w@example.invalid commit -qm ${name}`;

describe('a planner continues its own children with hub_continue', () => {
  let box: Sandbox;
  let db: Database;
  let hub: ContextHub;
  let pool: WorkerPool;
  let scheduler: ClusterScheduler;

  function startCluster(): void {
    hub = new ContextHub(box.config, db, join(box.stateDir, 'tickets'));
    pool = new WorkerPool(box.config, hub);
    pool.registerBackend(scriptBackend);
    const workspaces = new TaskWorkspaces(box.config, hub, new WorktreePool(box.config, db, box.registry), box.registry);
    scheduler = new ClusterScheduler(box.config, hub, pool, db, box.registry, workspaces);
    pool.setTaskCompletedCallback((task) => scheduler.markTaskCompleted(task));
    pool.setTaskUpdatedCallback((task) => scheduler.taskUpdated(task));
    pool.setTaskOpenWorkCallback((task) => scheduler.hasOpenWork(task));
    hub.setSchedulerBridge({
      submitChildTask: (opts) => scheduler.submitChildTask(opts),
      findTask: (taskId) => scheduler.findTask(taskId),
      isTaskSettled: (taskId) => scheduler.isTaskSettled(taskId),
      taskInboxed: (taskId, type) => scheduler.taskInboxed(taskId, type),
      routeMessage: (task) => scheduler.routeMessage(task),
    });
    hub.setReportCallback((_workerId, taskId, input) => {
      const task = taskId && scheduler.getActiveTask(taskId);
      if (!task) return;
      if (input.status === 'waiting') {
        task.status = 'waiting';
      } else {
        task.status = input.status === 'completed' ? 'completed' : 'failed';
        task.completedAt = new Date().toISOString();
      }
      scheduler.markTaskCompleted(task);
    });
  }

  const row = (id: string) => db.query('SELECT * FROM cluster_tasks WHERE id = ?').get(id) as Record<string, unknown>;
  const slotOf = (id: string) =>
    db.query('SELECT path FROM cluster_worktree_slots WHERE taskId = ?').get(id) as { path: string } | null;

  async function submit(script: string, template = EXECUTOR): Promise<TaskRecord> {
    const task = await scheduler.submitTask(PROJECT, script, { workerTemplate: template });
    if (!task) throw new Error('submitTask refused');
    await waitFor(() => task.status === 'running', 8000, 'task running');
    return task;
  }

  /** The worker's process is gone and the pool has settled its task. */
  const exited = (workerId: string) => waitFor(() => !pool.isWorkerLive(workerId), 8000, 'worker exited');

  /** The gate file a script waits for, so the test controls when the worker ends. */
  const gate = (name: string) => join(box.stateDir, name);
  const waitForGate = (name: string) => `while [ ! -e ${gate(name)} ]; do sleep 0.05; done`;

  beforeEach(async () => {
    box = await createSandbox();
    db = openClusterDb();
    launches.length = 0;
    resumes.length = 0;
    resumeScripts.clear();
    startCluster();
    await pool.start();
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    await pool.stop({ killWorkers: true });
    await scheduler.waitForSettling();
    db.close();
    box.cleanup();
  });

  /** Goes through `hub_spawn` as a planner would. */
  async function spawn(planner: TaskRecord, script: string, subscribe?: { tasks: string[] }): Promise<TaskRecord> {
    const { childTaskId } = await hub.handleSpawn(planner.workerId as string, {
      description: script,
      template: EXECUTOR,
      subscribe,
    });
    return scheduler.findTask(childTaskId) as TaskRecord;
  }

  test('a completed child is woken by its planner, caught up with what its siblings merged, and merges again', async () => {
    const planner = await submit(waitForGate('planner'), PLANNER);
    const first = await spawn(planner, commitAs('one'));
    await waitFor(() => scheduler.isTaskSettled(first.id), 8000, 'first child settled');
    const firstMergedAt = scheduler.findTask(first.id)?.mergedAt as string;
    expect(firstMergedAt).toBeDefined();

    const sibling = await spawn(planner, commitAs('sibling'));
    await waitFor(() => scheduler.isTaskSettled(sibling.id), 8000, 'sibling settled');

    resumeScripts.set(first.sessionId as string, commitAs('two'));
    expect(hub.handleContinue(planner.workerId as string, { taskId: first.id, instruction: 'also add two' })).toEqual({
      taskId: first.id,
      route: 'resume',
    });
    await waitFor(() => resumes.length === 1, 8000, 'child resumed');
    expect(resumes[0].taskPrompt).toContain('also add two');
    expect(resumes[0].taskPrompt).toContain('## 你上次结束以来，工作区的变化');
    expect(resumes[0].taskPrompt).toContain('- A\tsibling.txt');
    expect(hub.eventLog.query({ taskId: first.id }).map((e) => e.type)).toContain('directive');

    await waitFor(() => scheduler.isTaskSettled(first.id) && scheduler.findTask(first.id)?.mergedAt !== firstMergedAt, 8000);
    const log = await git(box.repo, ['log', '--format=%s', scheduler.getJob(planner.jobId)?.integrationBranch as string]);
    expect(log.split('\n')).toEqual(expect.arrayContaining(['one', 'sibling', 'two']));
    expect(Date.parse(scheduler.findTask(first.id)?.mergedAt as string)).toBeGreaterThan(Date.parse(firstMergedAt));
    expect(row(first.id).status).toBe('completed');
  });

  test('a running child receives the instruction as a directive for its worker', async () => {
    const planner = await submit(waitForGate('planner'), PLANNER);
    const child = await spawn(planner, waitForGate('child'));
    await waitFor(() => child.status === 'running', 8000, 'child running');
    expect(hub.handleContinue(planner.workerId as string, { taskId: child.id, instruction: 'new info' })).toEqual({
      taskId: child.id,
      route: 'worker',
    });
    expect(hub.messageBox.getUnreadCount(child.workerId as string)).toBe(1);
    writeFileSync(gate('child'), '');
  });

  test('a task that is not the planner\'s child is refused', async () => {
    const planner = await submit(waitForGate('planner'), PLANNER);
    const other = await submit(waitForGate('other'));
    expect(() => hub.handleContinue(planner.workerId as string, { taskId: other.id, instruction: 'x' })).toThrow(
      `hub_continue: task ${other.id} is not one of your children`,
    );
    expect(() => hub.handleContinue(planner.workerId as string, { taskId: 'missing', instruction: 'x' })).toThrow(
      'is not one of your children',
    );
  });

  test('a child that has not started is refused with the hint to spawn', async () => {
    const planner = await submit(waitForGate('planner'), PLANNER);
    const blocker = await spawn(planner, waitForGate('blocker'));
    const queued = await spawn(planner, 'true', { tasks: [blocker.id] });
    expect(queued.status).toBe('pending');
    expect(() => hub.handleContinue(planner.workerId as string, { taskId: queued.id, instruction: 'x' })).toThrow(
      /has not started.*hub_spawn a new executor instead/,
    );
    writeFileSync(gate('blocker'), '');
  });

  test('a continued child waits for a place like a spawned one when the job is at its maxChildren', async () => {
    const planner = await scheduler.submitTask(PROJECT, waitForGate('planner'), {
      workerTemplate: PLANNER,
      maxChildren: 1,
    });
    if (!planner) throw new Error('submitTask refused');
    await waitFor(() => planner.status === 'running', 8000, 'planner running');
    const first = await spawn(planner, commitAs('one'));
    await waitFor(() => scheduler.isTaskSettled(first.id), 8000, 'first settled');
    const busy = await spawn(planner, waitForGate('busy'));
    await waitFor(() => busy.status === 'running', 8000, 'second running');

    resumeScripts.set(first.sessionId as string, 'true');
    const attempts = spyOn(scheduler as unknown as { tryResume: () => Promise<string> }, 'tryResume');
    hub.handleContinue(planner.workerId as string, { taskId: first.id, instruction: 'again' });
    await waitFor(() => attempts.mock.results.length > 0, 8000, 'resume attempted');
    expect(await attempts.mock.results[0].value).toBe('busy');
    expect(resumes).toHaveLength(0);

    writeFileSync(gate('busy'), '');
    await waitFor(() => resumes.length === 1, 8000, 'continued child resumed after a place freed');
  });
});
