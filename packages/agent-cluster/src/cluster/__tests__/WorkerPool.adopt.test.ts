import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClusterConfig, parseClusterConfig } from '../config';
import type { ContextHub } from '../hub/ContextHub';
import type { TaskRecord, WorkerBackend } from '../types';
import { WorkerPool } from '../WorkerPool';

const TEMPLATE = 'fake';
const PROJECT = 'proj';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${label} not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The members of ContextHub the pool touches, recording the exits it reports. */
function stubHub(): { hub: ContextHub; exited: string[]; registered: string[] } {
  const exited: string[] = [];
  const registered: string[] = [];
  const hub = {
    workerRegistry: {
      register: (workerId: string) => {
        registered.push(workerId);
        return {};
      },
      setTask: () => {},
      get: () => undefined,
    },
    eventLog: { append: () => ({}) },
    messageBox: { send: () => 'message-id' },
    workerExited: (workerId: string) => {
      exited.push(workerId);
    },
  };
  return { hub: hub as unknown as ContextHub, exited, registered };
}

/** A backend that ignores the prompt and runs a shell script in the project directory. */
function fakeBackend(script: string): WorkerBackend {
  return {
    name: 'claude-cli',
    async launch(config) {
      return { cmd: ['sh', '-c', script], cwd: config.projectPath, env: config.env };
    },
    async verifyCredentials() {
      return { ok: true, credentialSource: 'test' };
    },
  };
}

function makeTask(id: string): TaskRecord {
  return {
    id,
    jobId: 'job-1',
    project: PROJECT,
    description: 'say hello',
    status: 'pending',
    source: 'queue',
    createdAt: new Date().toISOString(),
  };
}

/** Start a throwaway detached process outside the pool (a stand-in for a worker nobody follows). */
function spawnStray(script: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      if (child.pid === undefined) reject(new Error('no pid'));
      else resolve(child.pid);
    });
    child.once('error', reject);
    child.unref();
  });
}

describe('WorkerPool detached workers and adoption', () => {
  let stateDir: string;
  let projectDir: string;
  let config: ClusterConfig;
  const pids = new Set<number>();
  const pools: WorkerPool[] = [];

  function newPool(hub: ContextHub, script: string): WorkerPool {
    const pool = new WorkerPool(config, hub);
    pool.registerBackend(fakeBackend(script));
    pools.push(pool);
    return pool;
  }

  async function spawnTracked(pool: WorkerPool, task: TaskRecord) {
    await pool.start();
    const worker = await pool.spawnWorker(TEMPLATE, PROJECT, projectDir, task);
    if (!worker || worker.pid === null) throw new Error('spawnWorker returned no worker');
    pids.add(worker.pid);
    // What ClusterScheduler.tryDispatch stamps after a successful spawn.
    task.status = 'running';
    task.workerId = worker.id;
    task.workerTemplate = TEMPLATE;
    return { worker, pid: worker.pid };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'worker-pool-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'worker-pool-project-'));
    const parsed = parseClusterConfig({
      enabled: true,
      stateDir,
      workerTemplates: { [TEMPLATE]: { type: 'claude-cli', command: 'sh', args: [] } },
      projects: { [PROJECT]: { workerPreference: TEMPLATE } },
    });
    if (!parsed) throw new Error('parseClusterConfig returned null');
    config = parsed;
  });

  afterEach(async () => {
    for (const pool of pools.splice(0)) {
      await pool.stop({ killWorkers: true });
    }
    for (const pid of pids) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    pids.clear();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('spawnWorker starts a detached process and records pid, start time and log path on the task', async () => {
    const { hub, registered } = stubHub();
    const pool = newPool(hub, 'echo start; sleep 30; echo end');
    const task = makeTask('task-spawn');

    const { worker, pid } = await spawnTracked(pool, task);

    expect(registered).toEqual([worker.id]);
    expect(worker.status).toBe('running');
    expect(task.workerPid).toBe(pid);
    expect(task.workerStartedAt).toBeDefined();
    expect(Math.abs(Date.parse(task.workerStartedAt ?? '') - Date.now())).toBeLessThan(5000);
    expect(task.logPath).toBe(join(stateDir, 'assignments', 'task-spawn.out.log'));
    expect(worker.logPath).toBe(task.logPath ?? null);
    expect(isAlive(pid)).toBe(true);

    await waitFor(() => existsSync(task.logPath ?? '') && readFileSync(task.logPath ?? '', 'utf8').includes('start'));
    expect(existsSync(join(stateDir, 'assignments', 'task-spawn.err.log'))).toBe(true);
    await waitFor(() => (task.output ?? '').includes('start'), 3000, 'tail delivered stdout');
  });

  test('stop() leaves the worker running; a new pool adopts it and killWorkers ends it as failed', async () => {
    const first = stubHub();
    const pool = newPool(first.hub, 'echo start; sleep 30; echo end');
    const task = makeTask('task-adopt');
    const { worker, pid } = await spawnTracked(pool, task);
    await waitFor(() => (task.output ?? '').includes('start'), 3000, 'first pool saw stdout');

    await pool.stop();
    expect(isAlive(pid)).toBe(true);
    expect(first.exited).toEqual([]);
    expect(pool.getWorkers()).toEqual([]);

    // The scheduler that comes up next hands the persisted task to a fresh pool.
    const restored: TaskRecord = { ...task, output: undefined };
    const second = stubHub();
    const adopter = newPool(second.hub, 'unused');
    await adopter.start();
    const completed: TaskRecord[] = [];
    adopter.setTaskCompletedCallback((t) => {
      completed.push(t);
    });

    expect(adopter.adopt(restored)).toBe(true);
    const adopted = adopter.getWorkers();
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ id: worker.id, pid, child: null, status: 'running', logPath: task.logPath });
    expect(adopted[0]?.startedAt).toBe(Date.parse(task.workerStartedAt ?? ''));
    await waitFor(() => (restored.output ?? '').includes('start'), 3000, 'adopted tail re-read the log');

    await adopter.stop({ killWorkers: true });

    expect(isAlive(pid)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(second.exited).toEqual([worker.id]);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBe(restored);
    expect(restored.status).toBe('failed');
    expect(restored.error).toBe('Worker process ended without a terminal hub_report');
    expect(restored.completedAt).toBeDefined();
    expect(restored.output).toContain('start');
    expect(adopter.getWorkers()).toEqual([]);
  }, 15_000);

  test('a terminal status set by hub_report survives the kill', async () => {
    const pool = newPool(stubHub().hub, 'echo start; sleep 30');
    const task = makeTask('task-reported');
    const { pid } = await spawnTracked(pool, task);
    await pool.stop();

    const restored: TaskRecord = { ...task, status: 'completed', diffSummary: 'all done' };
    const adopter = newPool(stubHub().hub, 'unused');
    await adopter.start();
    expect(adopter.adopt(restored)).toBe(true);
    await adopter.stop({ killWorkers: true });

    expect(isAlive(pid)).toBe(false);
    expect(restored.status).toBe('completed');
    expect(restored.error).toBeUndefined();
  }, 15_000);

  test('adopt refuses a task whose worker pid is dead or missing', async () => {
    const pool = newPool(stubHub().hub, 'unused');
    await pool.start();
    const deadPid = await spawnStray('exit 0');
    await waitFor(() => !isAlive(deadPid), 3000, 'stray exited');

    const dead = makeTask('task-dead');
    dead.status = 'running';
    dead.workerId = 'worker-dead';
    dead.workerTemplate = TEMPLATE;
    dead.workerPid = deadPid;
    dead.workerStartedAt = new Date().toISOString();
    expect(pool.adopt(dead)).toBe(false);

    const noPid = makeTask('task-no-pid');
    noPid.workerId = 'worker-no-pid';
    expect(pool.adopt(noPid)).toBe(false);

    const noWorkerId = makeTask('task-no-worker');
    noWorkerId.workerPid = process.pid;
    expect(pool.adopt(noWorkerId)).toBe(false);

    expect(pool.getWorkers()).toEqual([]);
  });

  test('adopt refuses a live pid whose start time does not match the task (pid reuse)', async () => {
    const pool = newPool(stubHub().hub, 'unused');
    await pool.start();

    // This test process is alive, but it did not start an hour ago.
    const reused = makeTask('task-reused-pid');
    reused.status = 'running';
    reused.workerId = 'worker-reused';
    reused.workerTemplate = TEMPLATE;
    reused.workerPid = process.pid;
    reused.workerStartedAt = new Date(Date.now() - 3_600_000).toISOString();

    expect(pool.adopt(reused)).toBe(false);
    expect(pool.getWorkers()).toEqual([]);
  });

  test('killWorker signals the process group, so the worker’s own children die with it', async () => {
    const { hub, exited } = stubHub();
    const pool = newPool(hub, 'sleep 30 & echo "child=$!"; wait');
    const task = makeTask('task-group');
    const { worker, pid } = await spawnTracked(pool, task);
    const completed: TaskRecord[] = [];
    pool.setTaskCompletedCallback((t) => {
      completed.push(t);
    });

    await waitFor(() => /child=\d+/.test(task.output ?? ''), 3000, 'child pid echoed');
    const childPid = Number(/child=(\d+)/.exec(task.output ?? '')?.[1]);
    pids.add(childPid);
    expect(isAlive(childPid)).toBe(true);

    expect(await pool.killWorker(worker.id)).toBe(true);
    await waitFor(() => completed.length === 1, 5000, 'worker finalized');

    expect(isAlive(pid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(exited).toEqual([worker.id]);
    expect(task.status).toBe('failed');
    // A signal death reaches the exit handler with a null code, the same shape as an exit seen
    // by liveness polling, so it ends with the same error text.
    expect(task.error).toBe('Worker process ended without a terminal hub_report');
    expect(await pool.killWorker(worker.id)).toBe(false);
  }, 15_000);

  test('a worker that exits on its own completes the task from its exit code', async () => {
    const pool = newPool(stubHub().hub, 'echo hello; exit 0');
    const task = makeTask('task-exit');
    const completed: TaskRecord[] = [];
    pool.setTaskCompletedCallback((t) => {
      completed.push(t);
    });
    await spawnTracked(pool, task);

    await waitFor(() => completed.length === 1, 5000, 'worker finalized');
    expect(task.status).toBe('completed');
    expect(task.output?.trim()).toBe('hello');
    expect(pool.getWorkers()).toEqual([]);
  });

  test('a non-zero exit carries stderr into the error', async () => {
    const pool = newPool(stubHub().hub, 'echo boom >&2; exit 3');
    const task = makeTask('task-stderr');
    const completed: TaskRecord[] = [];
    pool.setTaskCompletedCallback((t) => {
      completed.push(t);
    });
    await spawnTracked(pool, task);

    await waitFor(() => completed.length === 1, 5000, 'worker finalized');
    expect(task.status).toBe('failed');
    expect(task.error).toBe('Process exited with code 3: boom');
  });
});

describe('applyUsage', () => {
  test('sums per-request samples and tracks the latest context size', async () => {
    const { applyUsage } = await import('../WorkerPool');
    const a = applyUsage(undefined, { input: 2, output: 10, cacheRead: 100, cacheCreation: 5 });
    const b = applyUsage(a, { input: 3, output: 20, cacheRead: 200, cacheCreation: 0 });
    expect(b).toEqual({
      contextTokens: 203,
      inputTokens: 5,
      outputTokens: 30,
      cacheReadTokens: 300,
      cacheCreationTokens: 5,
      turns: 2,
    });
  });

  test('a final sample replaces the sums with the CLI totals and sticks', async () => {
    const { applyUsage } = await import('../WorkerPool');
    const running = applyUsage(undefined, { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 });
    const done = applyUsage(running, { input: 44, output: 17298, cacheRead: 1340147, cacheCreation: 118797, turns: 46, costUsd: 1.85, final: true });
    expect(done.final).toBe(true);
    expect(done.outputTokens).toBe(17298);
    expect(done.turns).toBe(46);
    expect(done.contextTokens).toBe(3);
    expect(applyUsage(done, { input: 9, output: 9, cacheRead: 9, cacheCreation: 9 })).toBe(done);
  });
});
