import type { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
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

/** Workers run the last paragraph of their prompt as a shell script; resumed and forked ones run `nextScript`. */
const launches: WorkerSpawnConfig[] = [];
const resumes: WorkerResumeConfig[] = [];
const forks: WorkerResumeConfig[] = [];
let nextScript = 'true';
/** Launches that never report a session, as when a worker fails before its CLI starts one. */
let sessionless = false;

const scriptBackend: WorkerBackend = {
  name: 'claude-cli',
  async launch(config) {
    launches.push(config);
    const script = config.taskPrompt.split('\n\n').at(-1) ?? '';
    return {
      cmd: ['sh', '-c', script],
      cwd: config.projectPath,
      env: config.env,
      sessionId: sessionless ? undefined : `session-${config.workerId}`,
    };
  },
  async resume(config) {
    resumes.push(config);
    return { cmd: ['sh', '-c', nextScript], cwd: config.projectPath, env: config.env, sessionId: config.sessionId };
  },
  async fork(config) {
    forks.push(config);
    return { cmd: ['sh', '-c', nextScript], cwd: config.projectPath, env: config.env, sessionId: `fork-${config.workerId}` };
  },
  async verifyCredentials() {
    return { ok: true, credentialSource: 'test' };
  },
};

const commitAs = (name: string) =>
  `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=w -c user.email=w@example.invalid commit -qm ${name}`;

describe('ClusterScheduler retries a task in place, forks its session and deletes it', () => {
  let box: Sandbox;
  let db: Database;
  let hub: ContextHub;
  let pool: WorkerPool;
  let scheduler: ClusterScheduler;

  const row = (id: string) =>
    db.query('SELECT * FROM cluster_tasks WHERE id = ?').get(id) as Record<string, unknown> | null;

  async function submit(script: string, template = EXECUTOR): Promise<TaskRecord> {
    const task = await scheduler.submitTask(PROJECT, script, { workerTemplate: template });
    if (!task) throw new Error('submitTask refused');
    await waitFor(() => task.status === 'running', 8000, 'task running');
    return task;
  }

  const settled = (taskId: string) => waitFor(() => scheduler.isTaskSettled(taskId), 8000, `task ${taskId} settled`);

  beforeEach(async () => {
    box = await createSandbox();
    db = openClusterDb();
    launches.length = 0;
    resumes.length = 0;
    forks.length = 0;
    nextScript = 'true';
    sessionless = false;
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

  test('retrying a failed task wakes its own session in its slot, and the task and job reopen', async () => {
    const task = await submit(`${commitAs('partial')} && exit 1`);
    await settled(task.id);
    expect(row(task.id)?.status).toBe('failed');
    scheduler.acknowledgeTask(task.id);
    const slot = row(task.id)?.worktreePath as string;

    nextScript = commitAs('rest');
    const result = await scheduler.retryTask(task.id);
    expect(result).toEqual({ ok: true, mode: 'resume' });
    await waitFor(() => resumes.length === 1, 8000, 'resume launched');
    expect(resumes[0].sessionId).toBe(task.sessionId as string);
    expect(resumes[0].projectPath).toBe(slot);
    expect(resumes[0].taskPrompt).toContain('owner 让你重试');
    expect(launches).toHaveLength(1);
    expect(scheduler.findTask(task.id)?.acknowledgedAt).toBeUndefined();

    await waitFor(() => row(task.id)?.status === 'completed' && scheduler.isTaskSettled(task.id), 8000);
    expect(scheduler.getJob(task.jobId)?.status).toBe('completed');
    const log = await git(box.repo, ['log', '--format=%s', 'master']);
    expect(log.split('\n')).toEqual(expect.arrayContaining(['rest', 'partial']));
  });

  test('a task that never got a session restarts afresh under the same id', async () => {
    sessionless = true;
    const ready = join(box.stateDir, 'ready');
    const task = await scheduler.submitTask(PROJECT, `test -e ${ready} || exit 1; ${commitAs('second-try')}`, {
      workerTemplate: EXECUTOR,
    });
    if (!task) throw new Error('submitTask refused');
    await settled(task.id);
    expect(row(task.id)?.status).toBe('failed');
    expect(row(task.id)?.sessionId).toBeNull();

    sessionless = false;
    launches.length = 0;
    writeFileSync(ready, '');
    const result = await scheduler.retryTask(task.id);
    expect(result).toEqual({ ok: true, mode: 'restart' });
    await waitFor(() => launches.length === 1, 8000, 'relaunched');
    await waitFor(() => row(task.id)?.status === 'completed' && scheduler.isTaskSettled(task.id), 8000);
    expect(hub.eventLog.query({ taskId: task.id }).map((e) => e.type)).toContain('task_restarted');
    expect(resumes).toHaveLength(0);
  });

  test('a completed or running task is not retried', async () => {
    const running = await submit(`while [ ! -e ${join(box.stateDir, 'go')} ]; do sleep 0.05; done`);
    expect(scheduler.retryBlocker(running)).toBe('The task is running');
    writeFileSync(join(box.stateDir, 'go'), '');
    await settled(running.id);
    const done = scheduler.findTask(running.id) as TaskRecord;
    expect(done.status).toBe('completed');
    expect(scheduler.retryBlocker(done)).toBe('A completed task is continued with a message, not retried');
  });

  test('a fork copies the session into a new job, runs in the source slot and starts from its work', async () => {
    const source = await submit(`${commitAs('unlanded')} && exit 1`);
    await settled(source.id);
    const sourceRow = row(source.id) as Record<string, unknown>;

    nextScript = commitAs('forked');
    const result = await scheduler.forkTask(source.id, 'try it the other way');
    if (!result.ok) throw new Error(`fork refused: ${JSON.stringify(result)}`);
    const fork = result.task;
    expect(fork.id).not.toBe(source.id);
    expect(fork.jobId).not.toBe(source.jobId);
    expect(fork.forkedFrom).toBe(source.id);

    await waitFor(() => forks.length === 1, 8000, 'fork launched');
    expect(forks[0].sessionId).toBe(source.sessionId as string);
    expect(forks[0].projectPath).toBe(sourceRow.worktreePath as string);
    expect(forks[0].taskPrompt).toBe('try it the other way');
    expect(launches).toHaveLength(1);

    await waitFor(() => row(fork.id)?.status === 'completed' && scheduler.isTaskSettled(fork.id), 8000);
    expect(row(fork.id)?.sessionId).toBe(`fork-${fork.workerId}`);
    expect(row(fork.id)?.forkedFrom).toBe(source.id);
    // The source's unlanded commit came along and landed with the fork's job; the source is untouched.
    const master = await git(box.repo, ['log', '--format=%s', 'master']);
    expect(master.split('\n')).toEqual(expect.arrayContaining(['forked', 'unlanded']));
    expect(row(source.id)?.status).toBe('failed');
    expect(hub.eventLog.query({ taskId: fork.id }).map((e) => e.type)).toEqual(
      expect.arrayContaining(['task_forked', 'directive']),
    );
  });

  test('a fork is refused while the source runs or has no session', async () => {
    const running = await submit(`while [ ! -e ${join(box.stateDir, 'go')} ]; do sleep 0.05; done`);
    expect(scheduler.forkBlocker(running)).toBe('The task is running; fork it once its worker has exited');
    writeFileSync(join(box.stateDir, 'go'), '');
    await settled(running.id);
    const ended = scheduler.findTask(running.id) as TaskRecord;
    expect(scheduler.forkBlocker(ended)).toBeNull();
    ended.sessionId = undefined;
    expect(scheduler.forkBlocker(ended)).toBe('No session id was recorded for this task');
  });

  test('deleting a root task forgets its whole job and refuses a child or a live job', async () => {
    const planner = await submit(`while [ ! -e ${join(box.stateDir, 'planner')} ]; do sleep 0.05; done`, PLANNER);
    const child = await scheduler.submitChildTask({
      parentTaskId: planner.id,
      parentJobId: planner.jobId,
      project: PROJECT,
      description: commitAs('child'),
      template: EXECUTOR,
    });
    if (!child) throw new Error('child refused');
    await settled(child.id);

    expect(await scheduler.deleteTask(planner.id)).toEqual({
      ok: false,
      code: 'refused',
      reason: 'The job still has tasks running or landing; stop them first',
    });
    writeFileSync(join(box.stateDir, 'planner'), '');
    await settled(planner.id);
    expect(await scheduler.deleteTask(child.id)).toEqual({
      ok: false,
      code: 'refused',
      reason: 'A child task goes with its root task; delete that instead',
    });

    const result = await scheduler.deleteTask(planner.id);
    expect(result).toEqual({ ok: true, jobId: planner.jobId, deletedTasks: 2 });
    expect(scheduler.findTask(planner.id)).toBeUndefined();
    expect(scheduler.findTask(child.id)).toBeUndefined();
    expect(scheduler.resolveJob(planner.jobId)).toBeUndefined();
    expect(hub.eventLog.query({ taskId: child.id })).toHaveLength(0);
    expect(hub.workerRegistry.getWorkersByJobId(planner.jobId)).toHaveLength(0);
    expect(await scheduler.deleteTask(planner.id)).toEqual({ ok: false, code: 'not_found' });
  });
});
