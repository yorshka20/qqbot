import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import { ClusterScheduler } from '../ClusterScheduler';
import { type ClusterConfig, parseClusterConfig } from '../config';
import type { ContextHub } from '../hub/ContextHub';
import { createClusterTables } from '../schema';
import type { JobRecord, TaskRecord, WorkerBackend } from '../types';
import { WorkerPool } from '../WorkerPool';
import { TaskWorkspaces } from '../workspace/TaskWorkspaces';
import { WorktreePool } from '../workspace/WorktreePool';

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

/** The two tables the scheduler reads and writes, as `ClusterManager.initDatabase()` leaves them after migration. */
function openDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE cluster_jobs (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    taskCount INTEGER DEFAULT 0,
    tasksCompleted INTEGER DEFAULT 0,
    tasksFailed INTEGER DEFAULT 0,
    metadata TEXT,
    ticketId TEXT,
    integrationBranch TEXT,
    planning TEXT
  )`);
  db.run(`CREATE TABLE cluster_tasks (
    id TEXT PRIMARY KEY,
    jobId TEXT NOT NULL,
    project TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    workerId TEXT,
    workerTemplate TEXT,
    source TEXT,
    createdAt TEXT NOT NULL,
    claimedAt TEXT,
    startedAt TEXT,
    completedAt TEXT,
    output TEXT,
    error TEXT,
    filesModified TEXT,
    diffSummary TEXT,
    metadata TEXT,
    parentTaskId TEXT,
    workerPid INTEGER,
    workerStartedAt TEXT,
    logPath TEXT,
    sessionId TEXT,
    acknowledgedAt TEXT,
    model TEXT,
    usage TEXT,
    branch TEXT,
    worktreePath TEXT,
    mergedAt TEXT
  )`);
  createClusterTables(db);
  return db;
}

function insertJob(db: Database, job: JobRecord): void {
  db.query(
    `INSERT INTO cluster_jobs (id, project, description, status, createdAt, startedAt, taskCount, tasksCompleted, tasksFailed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(job.id, job.project, job.description, job.status, job.createdAt, job.startedAt ?? null, job.taskCount, 0, 0);
}

function insertRunningTask(db: Database, task: TaskRecord): void {
  db.query(
    `INSERT INTO cluster_tasks (id, jobId, project, description, status, workerId, workerTemplate, source, createdAt, startedAt, workerPid, workerStartedAt, logPath)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.jobId,
    task.project,
    task.description,
    task.status,
    task.workerId ?? null,
    task.workerTemplate ?? null,
    task.source,
    task.createdAt,
    task.startedAt ?? null,
    task.workerPid ?? null,
    task.workerStartedAt ?? null,
    task.logPath ?? null,
  );
}

function readTask(db: Database, id: string): Record<string, unknown> {
  return db.query('SELECT * FROM cluster_tasks WHERE id = ?').get(id) as Record<string, unknown>;
}

function readJob(db: Database, id: string): Record<string, unknown> {
  return db.query('SELECT * FROM cluster_jobs WHERE id = ?').get(id) as Record<string, unknown>;
}

function stubHub(): ContextHub {
  return {
    workerRegistry: { register: () => ({}), setTask: () => {}, get: () => undefined },
    eventLog: { append: () => ({}) },
    messageBox: { send: () => 'message-id' },
    workerExited: () => {},
    taskSettled: () => {},
  } as unknown as ContextHub;
}

function stubProjectRegistry(path: string): ProjectRegistry {
  return {
    resolve: (alias?: string) => (alias === PROJECT ? { alias: PROJECT, path, type: 'generic' } : null),
  } as unknown as ProjectRegistry;
}

const neverLaunched: WorkerBackend = {
  name: 'claude-cli',
  async launch() {
    throw new Error('this test never spawns through the pool');
  },
  async verifyCredentials() {
    return { ok: true, credentialSource: 'test' };
  },
};

/** A detached process the scheduler did not start, standing in for a worker left behind by its predecessor. */
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

describe('ClusterScheduler.adoptRunningTasks', () => {
  let db: Database;
  let stateDir: string;
  let projectDir: string;
  let config: ClusterConfig;
  let pool: WorkerPool;
  let scheduler: ClusterScheduler;
  const pids = new Set<number>();

  function runningTask(id: string, workerPid: number, startedAt = new Date()): TaskRecord {
    return {
      id,
      jobId: `job-${id}`,
      project: PROJECT,
      description: `work for ${id}`,
      status: 'running',
      workerId: `worker-${id}`,
      workerTemplate: TEMPLATE,
      source: 'queue',
      createdAt: startedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      workerPid,
      workerStartedAt: startedAt.toISOString(),
      logPath: join(stateDir, 'assignments', `${id}.out.log`),
    };
  }

  function jobFor(task: TaskRecord): JobRecord {
    return {
      id: task.jobId,
      project: PROJECT,
      description: task.description,
      status: 'running',
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      taskCount: 1,
      tasksCompleted: 0,
      tasksFailed: 0,
      planning: 'auto',
    };
  }

  beforeEach(() => {
    db = openDb();
    stateDir = mkdtempSync(join(tmpdir(), 'scheduler-state-'));
    projectDir = mkdtempSync(join(tmpdir(), 'scheduler-project-'));
    const parsed = parseClusterConfig({
      enabled: true,
      stateDir,
      schedulingInterval: 60_000,
      workerTemplates: { [TEMPLATE]: { type: 'claude-cli', command: 'sh', args: [] } },
      projects: { [PROJECT]: { workerPreference: TEMPLATE } },
    });
    if (!parsed) throw new Error('parseClusterConfig returned null');
    config = parsed;
    const hub = stubHub();
    pool = new WorkerPool(config, hub);
    pool.registerBackend(neverLaunched);
    const registry = stubProjectRegistry(projectDir);
    const workspaces = new TaskWorkspaces(config, hub, new WorktreePool(config, db, registry), registry);
    scheduler = new ClusterScheduler(config, hub, pool, db, registry, workspaces);
    pool.setTaskCompletedCallback((task) => scheduler.markTaskCompleted(task));
  });

  afterEach(async () => {
    await scheduler.stop();
    await pool.stop({ killWorkers: true });
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
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('a running task whose worker is gone ends as failed on start()', async () => {
    const deadPid = await spawnStray('exit 0');
    await waitFor(() => !isAlive(deadPid), 3000, 'stray exited');
    const task = runningTask('dead', deadPid);
    insertJob(db, jobFor(task));
    insertRunningTask(db, task);

    await pool.start();
    await scheduler.start();

    const row = readTask(db, 'dead');
    expect(row.status).toBe('failed');
    expect(row.error).toContain('not found after scheduler restart');
    expect(row.completedAt).toBeTruthy();
    expect(scheduler.getActiveTasks()).toEqual([]);
    expect(pool.getWorkers()).toEqual([]);

    const job = readJob(db, task.jobId);
    expect(job).toMatchObject({ status: 'failed', tasksFailed: 1, tasksCompleted: 0 });
    expect(scheduler.getJob(task.jobId)?.status).toBe('failed');
  });

  test('a running task whose worker is still alive is adopted and finished when the worker ends', async () => {
    const livePid = await spawnStray('sleep 30');
    pids.add(livePid);
    const task = runningTask('live', livePid);
    insertJob(db, jobFor(task));
    insertRunningTask(db, task);

    await pool.start();
    await scheduler.start();

    expect(readTask(db, 'live').status).toBe('running');
    expect(scheduler.getActiveTask('live')).toMatchObject({ status: 'running', workerPid: livePid });
    expect(pool.getWorkers().map((w) => [w.id, w.pid])).toEqual([['worker-live', livePid]]);
    expect(scheduler.getJob(task.jobId)?.status).toBe('running');

    await pool.stop({ killWorkers: true });

    expect(isAlive(livePid)).toBe(false);
    const row = readTask(db, 'live');
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Worker process ended without a terminal hub_report');
    expect(scheduler.getActiveTasks()).toEqual([]);
    expect(readJob(db, task.jobId)).toMatchObject({ status: 'failed', tasksFailed: 1 });
  }, 15_000);

  test('only running or claimed rows with a pid are considered', async () => {
    const pendingNoPid = runningTask('pending', 0);
    pendingNoPid.status = 'pending';
    pendingNoPid.workerPid = undefined;
    const completedOld = runningTask('finished', 99_999);
    completedOld.status = 'completed';
    for (const task of [pendingNoPid, completedOld]) {
      insertJob(db, jobFor(task));
      insertRunningTask(db, task);
    }

    await pool.start();
    await scheduler.start();

    expect(readTask(db, 'pending').status).toBe('pending');
    expect(readTask(db, 'finished').status).toBe('completed');
    expect(scheduler.getActiveTasks()).toEqual([]);
  });
});
