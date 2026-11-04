import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

describe('ClusterScheduler resumes a session instead of keeping its worker alive', () => {
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

  test('a worker that reports waiting parks its task with its slot, and a message resumes it in the same slot', async () => {
    const task = await submit(`${commitAs('first')}; ${waitForGate('exit1')}`);
    const workerId = task.workerId as string;
    const slot = slotOf(task.id)?.path;
    expect(slot).toBeDefined();

    hub.handleReport(workerId, { status: 'waiting', summary: 'waiting for the owner' });
    writeFileSync(gate('exit1'), '');
    await exited(workerId);
    expect(row(task.id).status).toBe('waiting');

    expect(scheduler.getActiveTask(task.id)?.status).toBe('waiting');
    expect(slotOf(task.id)?.path).toBe(slot);
    expect(scheduler.isTaskSettled(task.id)).toBe(false);
    expect(scheduler.routeMessage(task)).toEqual({ kind: 'resume' });
    expect(row(task.id).completedAt).toBeNull();

    resumeScripts.set(task.sessionId as string, commitAs('second'));
    hub.messageTask(task.id, 'please add the second file');
    await waitFor(() => resumes.length === 1, 8000, 'resume launched');

    expect(resumes[0].sessionId).toBe(task.sessionId as string);
    expect(resumes[0].projectPath).toBe(slot as string);
    expect(resumes[0].taskPrompt).toContain('你被唤醒了');
    expect(resumes[0].taskPrompt).toContain('please add the second file');
    expect(launches).toHaveLength(1);

    await waitFor(() => scheduler.isTaskSettled(task.id), 8000, 'resumed task settled');
    expect(row(task.id).status).toBe('completed');
    expect(row(task.id).resumeCount).toBe(1);
    // The fake worker never reports completed; its clean exit ends the task, and its branch lands.
    expect(hub.eventLog.query({ taskId: task.id }).map((e) => e.type)).toEqual(
      expect.arrayContaining(['task_waiting', 'directive', 'task_resumed', 'task_merged']),
    );
    const branch = row(task.id).branch as string;
    const log = await git(box.repo, ['log', '--format=%s', branch]);
    expect(log.split('\n')).toEqual(['second', 'first', 'initial']);
    expect(slotOf(task.id)).toBeNull();
  });

  test('a message to a completed task reopens it and its job, then both complete again', async () => {
    const task = await submit(commitAs('done'));
    await waitFor(() => scheduler.isTaskSettled(task.id), 8000, 'task settled');
    const job = scheduler.getJob(task.jobId);
    expect(job?.status).toBe('completed');
    expect(job?.tasksCompleted).toBe(1);
    const slot = row(task.id).worktreePath as string;
    expect(slotOf(task.id)).toBeNull();

    expect(scheduler.routeMessage(scheduler.findTask(task.id) as TaskRecord)).toEqual({ kind: 'resume' });
    resumeScripts.set(task.sessionId as string, commitAs('more'));
    hub.messageTask(task.id, 'one more thing');
    await waitFor(() => resumes.length === 1, 8000, 'resume launched');
    expect(resumes[0].projectPath).toBe(slot as string);
    expect(scheduler.getJob(task.jobId)?.status).toBe('running');
    expect(scheduler.getJob(task.jobId)?.tasksCompleted).toBe(0);

    await waitFor(() => scheduler.isTaskSettled(task.id) && scheduler.getJob(task.jobId)?.status === 'completed', 8000);
    expect(scheduler.getJob(task.jobId)?.tasksCompleted).toBe(1);
    expect(row(task.id).status).toBe('completed');
    const master = await git(box.repo, ['log', '--format=%s', 'master']);
    expect(master.split('\n')).toEqual(expect.arrayContaining(['more', 'done']));
  });

  test('a planner that ends its turn while a child runs is parked and woken by the child ending', async () => {
    const planner = await submit(waitForGate('planner'), PLANNER);
    const child = await scheduler.submitChildTask({
      parentTaskId: planner.id,
      parentJobId: planner.jobId,
      project: PROJECT,
      description: `${waitForGate('child')}; ${commitAs('child')}`,
      template: EXECUTOR,
    });
    if (!child) throw new Error('child refused');
    await waitFor(() => child.status === 'running', 8000, 'child running');
    // The planner ends its turn (exit 0, no report) with the child still running.
    writeFileSync(gate('planner'), '');
    await waitFor(() => row(planner.id).status === 'waiting', 8000, 'planner parked');
    expect(scheduler.getActiveTask(planner.id)?.status).toBe('waiting');
    expect(slotOf(planner.id)).not.toBeNull();

    resumeScripts.set(planner.sessionId as string, 'true');
    writeFileSync(gate('child'), '');
    await waitFor(() => resumes.length === 1, 8000, 'planner resumed');
    expect(resumes[0].sessionId).toBe(planner.sessionId as string);
    expect(resumes[0].taskPrompt).toContain('task_completed');
    expect(resumes[0].taskPrompt).toContain(child.id);

    // The resumed planner ends its turn again with nothing running: now it is done.
    await waitFor(() => scheduler.isTaskSettled(planner.id), 8000, 'planner settled');
    expect(row(planner.id).status).toBe('completed');
    expect(scheduler.getJob(planner.jobId)?.status).toBe('completed');
  });

  test('a parked task survives a scheduler restart and wakes from what arrived meanwhile', async () => {
    const task = await submit(`${waitForGate('exit2')}`);
    hub.handleReport(task.workerId as string, { status: 'waiting', summary: 'parked' });
    writeFileSync(gate('exit2'), '');
    await exited(task.workerId as string);
    expect(row(task.id).status).toBe('waiting');

    await scheduler.stop();
    await pool.stop();
    // Nothing runs: the message waits in the task's inbox in the database.
    hub.messageTask(task.id, 'while you were away');

    startCluster();
    await pool.start();
    hub.workerRegistry.hydrateFromDb();
    resumeScripts.set(task.sessionId as string, 'true');
    await scheduler.start();
    // Restored as parked, and woken right away by the message that waited in its inbox.
    expect(['waiting', 'claimed', 'running']).toContain(scheduler.getActiveTask(task.id)?.status as string);
    await waitFor(() => resumes.length === 1, 8000, 'resumed after restart');
    expect(resumes[0].taskPrompt).toContain('while you were away');
    await waitFor(() => scheduler.isTaskSettled(task.id), 8000, 'settled');
    expect(existsSync(gate('exit2'))).toBe(true);
  });

  test('a task whose backend cannot resume refuses the message', async () => {
    const task = await submit(commitAs('solo'));
    await waitFor(() => scheduler.isTaskSettled(task.id), 8000, 'settled');
    const stored = scheduler.findTask(task.id) as TaskRecord;
    stored.sessionId = undefined;
    expect(scheduler.routeMessage(stored)).toEqual({
      kind: 'refused',
      reason: 'No session id was recorded for this task',
    });
  });
});
