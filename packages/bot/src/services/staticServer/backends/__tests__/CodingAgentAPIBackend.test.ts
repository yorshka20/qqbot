import 'reflect-metadata';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodingAgentService } from '@/services/codingAgent/CodingAgentService';
import { CodingAgentTaskStore } from '@/services/codingAgent/CodingAgentTaskStore';
import type { AgentTask } from '@/services/codingAgent/types';
import { CodingAgentAPIBackend } from '../CodingAgentAPIBackend';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-0001',
    executor: 'dsh',
    model: 'deepseek-flash',
    prompt: '调研三个向量数据库',
    createdAt: new Date(2026, 9, 10, 16, 52, 3),
    status: 'pending',
    requestedBy: { type: 'group', id: '10000001', userId: '10000002' },
    taskType: 'workspace',
    ...overrides,
  };
}

/** A backend over a real record store plus the parts of the service the routes touch. */
function makeBackend(options: { tasks?: AgentTask[]; cancel?: (id: string) => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coding-agent-api-'));
  dirs.push(root);
  const store = new CodingAgentTaskStore(root);

  for (const task of options.tasks ?? []) {
    const directory = store.claimDirectory(task);
    task.recordDirectory = directory;
    task.workingDirectory = directory;
    store.create(task, directory);
    const at = task.createdAt.getTime() + 1_000;
    if (task.status !== 'pending') {
      store.record(task, { kind: 'running', at, message: '开始执行' });
    }
    if (task.status === 'completed' || task.status === 'failed') {
      store.record(task, { kind: task.status, at: at + 1_000, message: '结束' });
    }
    store.appendOutput(task, 'stdout', `stdout of ${task.id}\n`);
    store.appendOutput(task, 'stderr', `stderr of ${task.id}\n`);
  }

  const service = {
    getTaskStore: () => store,
    getStatus: () => ({
      enabled: true,
      defaultExecutor: 'dsh',
      runningTasks: 1,
      pendingTasks: 0,
      queueInfo: [{ project: 'workspace', running: 'task-0001', queued: 0 }],
    }),
    getExecutor: (name: string) => ({ displayName: `${name} display` }),
    cancelTask: options.cancel ?? (() => false),
  } as unknown as CodingAgentService;

  return { backend: new CodingAgentAPIBackend(() => service), store };
}

/** Mirrors StaticServer: the backend gets the pathname, and reads the query off the Request. */
async function get(backend: CodingAgentAPIBackend, path: string) {
  const url = `http://local/api/agents${path}`;
  const res = await backend.handle(new URL(url).pathname, new Request(url));
  return { status: res?.status ?? 0, body: (await res?.json()) as any };
}

describe('CodingAgentAPIBackend status', () => {
  test('says so rather than failing when the service is not enabled', async () => {
    const backend = new CodingAgentAPIBackend(() => null);
    expect(await get(backend, '/status')).toEqual({ status: 200, body: { enabled: false, executors: [] } });
  });

  test('lists the executors and the live queue by display name', async () => {
    const { backend } = makeBackend();
    const { body } = await get(backend, '/status');

    expect(body.enabled).toBe(true);
    expect(body.defaultExecutor).toBe('dsh');
    expect(body.runningTasks).toBe(1);
    expect(body.queue).toEqual([{ project: 'workspace', running: 'task-0001', queued: 0 }]);
    expect(body.executors.map((e: { name: string }) => e.name)).toEqual(['claude', 'codex', 'dsh']);
    expect(body.executors[0].displayName).toBe('claude display');
  });
});

describe('CodingAgentAPIBackend tasks', () => {
  test('lists records newest first with the prompt shortened', async () => {
    const older = makeTask({ id: 'older', createdAt: new Date(2026, 9, 9, 9, 0, 0), prompt: '甲'.repeat(400) });
    const newer = makeTask({ id: 'newer', createdAt: new Date(2026, 9, 10, 9, 0, 0), prompt: '乙' });
    const { backend } = makeBackend({ tasks: [older, newer] });

    const { body } = await get(backend, '/tasks');
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual(['newer', 'older']);
    expect(body.tasks[1].prompt.endsWith('…')).toBe(true);
    expect(body.tasks[1].prompt.length).toBeLessThanOrEqual(301);
  });

  test('filters by status, and reports an empty list when the service is off', async () => {
    const { backend } = makeBackend({
      tasks: [makeTask({ id: 'done', status: 'completed' }), makeTask({ id: 'gone', status: 'failed' })],
    });

    const { body } = await get(backend, '/tasks?status=completed');
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual(['done']);

    const off = new CodingAgentAPIBackend(() => null);
    expect((await get(off, '/tasks')).body).toEqual({ enabled: false, tasks: [] });
  });

  test('returns one record whole, and 404s for an unknown id', async () => {
    const { backend } = makeBackend({ tasks: [makeTask({ status: 'completed', result: '结论：甲更好' })] });

    const found = await get(backend, '/tasks/task-0001');
    expect(found.body.result).toBe('结论：甲更好');
    expect(found.body.id).toBe('task-0001');
    expect(found.body.directory).toBeTruthy();

    expect((await get(backend, '/tasks/no-such-task')).status).toBe(404);
  });

  test('returns the timeline and the raw output', async () => {
    const { backend } = makeBackend({ tasks: [makeTask({ status: 'completed', result: 'ok' })] });

    const events = await get(backend, '/tasks/task-0001/events');
    expect(events.body.map((e: { kind: string }) => e.kind)).toEqual(['created', 'running', 'completed']);

    const output = await get(backend, '/tasks/task-0001/output');
    expect(output.body.stdout).toContain('stdout of task-0001');
    expect(output.body.stderr).toContain('stderr of task-0001');
    expect(output.body.stdoutTruncated).toBe(false);
  });

  test('keeps only the tail of an oversized transcript, and says it did', async () => {
    const { backend, store } = makeBackend({ tasks: [makeTask()] });
    const directory = store.get('task-0001')?.directory ?? '';
    store.appendOutput({ recordDirectory: directory } as AgentTask, 'stdout', 'x'.repeat(200_001));

    const { body } = await get(backend, '/tasks/task-0001/output');
    expect(body.stdoutTruncated).toBe(true);
    expect(body.stdout.length).toBe(200_000);
  });
});

describe('CodingAgentAPIBackend writes', () => {
  test('cancel delegates to the live service, and reports when it refused', async () => {
    const cancelled: string[] = [];
    const { backend } = makeBackend({
      cancel: (id) => {
        cancelled.push(id);
        return id === 'task-0001';
      },
    });

    const post = async (path: string) => {
      const url = `http://local/api/agents${path}`;
      return backend.handle(new URL(url).pathname, new Request(url, { method: 'POST' }));
    };
    expect(await (await post('/tasks/task-0001/cancel'))?.json()).toEqual({ cancelled: true });
    expect(await (await post('/tasks/other/cancel'))?.json()).toEqual({ cancelled: false });
    expect(cancelled).toEqual(['task-0001', 'other']);
  });

  test('an unknown route is a 404 and an unsupported method a 405', async () => {
    const { backend } = makeBackend();
    expect((await get(backend, '/nope')).status).toBe(404);
    expect((await get(backend, '/tasks/task-0001/nope')).status).toBe(404);

    const put = await backend.handle('/api/agents/tasks', new Request('http://local/api/agents/tasks', { method: 'PUT' }));
    expect(put?.status).toBe(405);
  });
});
