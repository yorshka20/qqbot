import { describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingAgentTaskStore } from '../CodingAgentTaskStore';
import { TASK_EVENTS_FILE, TASK_RECORD_FILE, TASK_STATE_FILE, TASK_STDOUT_FILE } from '../taskWorkspace';
import type { AgentTask } from '../types';

const CREATED_AT = new Date(2026, 9, 10, 16, 52, 3);

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    executor: 'dsh',
    model: 'deepseek-flash',
    prompt: '调研三个向量数据库',
    createdAt: CREATED_AT,
    status: 'pending',
    requestedBy: { type: 'group', id: '10000001', userId: '10000002' },
    taskType: 'workspace',
    ...overrides,
  };
}

/** A store plus one opened task, which is the state the manager hands it. */
function openTask(overrides: Partial<AgentTask> = {}) {
  const store = new CodingAgentTaskStore(mkdtempSync(join(tmpdir(), 'coding-agent-store-')));
  const task = makeTask(overrides);
  const directory = store.claimDirectory(task);
  task.recordDirectory = directory;
  task.workingDirectory = directory;
  store.create(task, directory);
  return { store, task, directory };
}

describe('CodingAgentTaskStore directories', () => {
  test('names the directory after the day and the request', () => {
    const store = new CodingAgentTaskStore(mkdtempSync(join(tmpdir(), 'coding-agent-store-')));
    expect(store.claimDirectory(makeTask())).toBe(
      join((store as unknown as { root: string }).root, '2026-10-10-调研三个向量数据库'),
    );
  });

  test('two tasks asking the same thing on the same day get different directories', () => {
    const store = new CodingAgentTaskStore(mkdtempSync(join(tmpdir(), 'coding-agent-store-')));
    const first = store.claimDirectory(makeTask());
    const second = store.claimDirectory(makeTask({ id: 'other-id' }));

    expect(second).not.toBe(first);
    expect(second.endsWith('-2')).toBe(true);
    expect(existsSync(first)).toBe(true);
  });
});

describe('CodingAgentTaskStore record', () => {
  test('create leaves the request, the state and the first event', () => {
    const { task, directory } = openTask();

    expect(readFileSync(join(directory, TASK_RECORD_FILE), 'utf8')).toContain('调研三个向量数据库');
    expect(JSON.parse(readFileSync(join(directory, TASK_STATE_FILE), 'utf8'))).toMatchObject({
      id: task.id,
      status: 'pending',
      executor: 'dsh',
    });
    expect(readFileSync(join(directory, TASK_EVENTS_FILE), 'utf8')).toContain('"kind":"created"');
  });

  test('an event updates the state file and appends to the timeline and the record', () => {
    const { store, task, directory } = openTask();
    task.status = 'running';
    task.startedAt = new Date(2026, 9, 10, 16, 53, 0);
    store.record(task, { kind: 'running', at: CREATED_AT.getTime() + 60_000, message: '开始执行' });

    expect(JSON.parse(readFileSync(join(directory, TASK_STATE_FILE), 'utf8')).status).toBe('running');
    expect(readFileSync(join(directory, TASK_RECORD_FILE), 'utf8')).toContain('开始执行');
    expect(store.readEvents(directory).map((e) => e.kind)).toEqual(['created', 'running']);
  });

  test('the outcome is carried in the state file and the timeline', () => {
    const { store, task, directory } = openTask();
    task.status = 'completed';
    task.result = '结论：甲更好';
    store.record(task, { kind: 'completed', at: CREATED_AT.getTime() + 120_000, message: '执行完成' });

    expect(JSON.parse(readFileSync(join(directory, TASK_STATE_FILE), 'utf8')).result).toBe('结论：甲更好');
    expect(readFileSync(join(directory, TASK_RECORD_FILE), 'utf8')).toContain('## 结果\n\n结论：甲更好');
    expect(store.readEvents(directory).at(-1)?.kind).toBe('completed');
  });

  test('the raw output of both streams is kept', () => {
    const { store, task, directory } = openTask();
    store.appendOutput(task, 'stdout', 'partial ');
    store.appendOutput(task, 'stdout', 'line');
    store.appendOutput(task, 'stderr', 'a warning');
    store.appendOutput(task, 'stdout', '');

    expect(store.readOutput(directory)).toEqual({ stdout: 'partial line', stderr: 'a warning' });
  });

  test('a record write without a directory is a no-op rather than a crash', () => {
    const store = new CodingAgentTaskStore(mkdtempSync(join(tmpdir(), 'coding-agent-store-')));
    expect(() => store.record(makeTask(), { kind: 'running', at: Date.now() })).not.toThrow();
  });
});

describe('CodingAgentTaskStore reads', () => {
  test('lists tasks newest first and ignores directories that are not task records', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-agent-store-'));
    const store = new CodingAgentTaskStore(root);

    const older = makeTask({ id: 'older', prompt: '甲', createdAt: new Date(2026, 9, 9, 10, 0, 0) });
    const newer = makeTask({ id: 'newer', prompt: '乙', createdAt: new Date(2026, 9, 10, 10, 0, 0) });
    for (const task of [older, newer]) {
      const directory = store.claimDirectory(task);
      task.recordDirectory = directory;
      store.create(task, directory);
    }
    mkdirSync(join(root, 'not-a-task'));

    expect(store.list().map((t) => t.id)).toEqual(['newer', 'older']);
    expect(store.list(1).map((t) => t.id)).toEqual(['newer']);
  });

  test('finds a task by id, whichever directory it sits in', () => {
    const { store, task } = openTask();
    expect(store.get(task.id)?.prompt).toBe('调研三个向量数据库');
    expect(store.get('no-such-task')).toBeNull();
  });

  test('a half-written trailing event line does not lose the rest of the timeline', () => {
    const { store, directory } = openTask();
    appendFileSync(join(directory, TASK_EVENTS_FILE), '{"kind":"running"');

    expect(store.readEvents(directory).map((e) => e.kind)).toEqual(['created']);
  });

  test('a missing or unreadable record reads as empty rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-agent-store-'));
    const store = new CodingAgentTaskStore(root);
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken', TASK_STATE_FILE), 'not json');

    expect(store.list()).toEqual([]);
    expect(store.readEvents(join(root, 'nowhere'))).toEqual([]);
    expect(store.readOutput(join(root, 'nowhere'))).toEqual({ stdout: '', stderr: '' });
  });

  test('a task left running by a previous process is closed, not left claiming to run', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-agent-store-'));
    const store = new CodingAgentTaskStore(root);
    const open = (overrides: Partial<AgentTask>) => {
      const task = makeTask(overrides);
      const dir = store.claimDirectory(task);
      task.recordDirectory = dir;
      store.create(task, dir);
      return { task, dir };
    };

    const running = open({});
    running.task.status = 'running';
    store.record(running.task, { kind: 'running', at: CREATED_AT.getTime() + 1_000, message: '开始执行' });
    const ended = open({ id: 'finished', prompt: '乙', status: 'completed' });
    store.record(ended.task, { kind: 'completed', at: CREATED_AT.getTime() + 1_000, message: '执行完成' });
    const directory = running.dir;

    expect(store.closeInterruptedTasks('服务重启，任务中断')).toBe(1);

    const closed = JSON.parse(readFileSync(join(directory, TASK_STATE_FILE), 'utf8'));
    expect(closed.status).toBe('failed');
    expect(closed.error).toBe('服务重启，任务中断');
    expect(closed.finishedAt).toBeDefined();
    expect(readFileSync(join(directory, TASK_RECORD_FILE), 'utf8')).toContain('## 错误\n\n服务重启，任务中断');
    expect(store.readEvents(directory).at(-1)).toMatchObject({ kind: 'failed', message: '服务重启，任务中断' });
    // A record that already ended is left alone.
    expect(store.get('finished')?.status).toBe('completed');
  });

  test('closing interrupted tasks twice is a no-op the second time', () => {
    const { store, task } = openTask();
    task.status = 'running';
    store.record(task, { kind: 'running', at: CREATED_AT.getTime() + 1_000 });

    expect(store.closeInterruptedTasks('中断')).toBe(1);
    expect(store.closeInterruptedTasks('中断')).toBe(0);
  });

  test('listing a root that does not exist yet is empty, not an error', () => {
    const store = new CodingAgentTaskStore(join(tmpdir(), 'coding-agent-store-missing', 'nested'));
    expect(store.list()).toEqual([]);
    expect(store.get('anything')).toBeNull();
  });

  test('the stdout file name is the one the store reads back', () => {
    const { store, task, directory } = openTask();
    store.appendOutput(task, 'stdout', 'x');
    expect(readFileSync(join(directory, TASK_STDOUT_FILE), 'utf8')).toBe('x');
  });
});
