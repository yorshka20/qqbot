import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClusterConfig } from '../../config';
import { createClusterTables } from '../../schema';
import { ContextHub, type SchedulerBridge } from '../ContextHub';

let dir: string;
let hub: ContextHub;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-wait-'));
  const db = new Database(':memory:');
  createClusterTables(db);
  const config = parseClusterConfig({ enabled: true, stateDir: dir, workerTemplates: { tpl: { type: 'claude-cli' } }, projects: {} });
  if (!config) throw new Error('config');
  hub = new ContextHub(config, db, join(dir, 'tickets'));
  hub.workerRegistry.register('planner-1', { role: 'planner', project: 'p', templateName: 'tpl' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hub_wait', () => {
  test('wakes when a watched task settles, without polling', async () => {
    const waiting = hub.handleWait('planner-1', { tasks: ['child-a', 'child-b'], timeoutMs: 5_000 });
    await Bun.sleep(20);
    hub.taskSettled('child-b');
    const result = await waiting;
    expect(result.reason).toBe('task');
  });

  test('wakes when a message or an owner directive arrives for the waiter', async () => {
    const waiting = hub.handleWait('planner-1', { timeoutMs: 5_000 });
    await Bun.sleep(20);
    hub.messageWorker('planner-1', 'task-x', 'change of plan');
    const result = await waiting;
    expect(result.reason).toBe('message');
    expect(result.updates.map((u) => [u.type, u.summary])).toEqual([['directive', 'change of plan']]);
  });

  test('answers at once when a message is already queued', async () => {
    hub.messageBox.send('planner-1', 'hub', 'queued earlier', 'directive');
    const result = await hub.handleWait('planner-1', { timeoutMs: 5_000 });
    expect(result.reason).toBe('message');
    expect(result.updates).toHaveLength(1);
  });

  test('times out when nothing happens, and leaves no waiter behind', async () => {
    const result = await hub.handleWait('planner-1', { tasks: ['child-a'], timeoutMs: 50 });
    expect(result.reason).toBe('timeout');
    hub.taskSettled('child-a');
  });

  test('a settled task does not wake a waiter that does not watch it', async () => {
    const waiting = hub.handleWait('planner-1', { tasks: ['child-a'], timeoutMs: 120 });
    await Bun.sleep(10);
    hub.taskSettled('child-z');
    const result = await waiting;
    expect(result.reason).toBe('timeout');
  });
});

describe('hub_wait snapshots and hub_query_task output', () => {
  const child = (output: string) => ({
    id: 'child-a',
    jobId: 'job-1',
    project: 'p',
    description: 'child',
    status: 'running',
    workerId: 'exec-1',
    parentTaskId: 'task-p',
    createdAt: new Date().toISOString(),
    output,
  });

  function wire(output: string): void {
    hub.setSchedulerBridge({
      findTask: (id: string) => (id === 'child-a' ? child(output) : undefined),
      isTaskSettled: () => false,
    } as unknown as SchedulerBridge);
    hub.workerRegistry.setTask('planner-1', 'task-p');
  }

  test('a wait answer carries the watched tasks without their stdout', async () => {
    wire('x'.repeat(50_000));
    const result = await hub.handleWait('planner-1', { tasks: ['child-a'], timeoutMs: 20 });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe('running');
    expect('output' in result.tasks[0]).toBe(false);
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  test('hub_query_task returns only the tail of a long live stdout and says so', () => {
    wire(`${'a'.repeat(50_000)}END`);
    const snapshot = hub.handleQueryTask('planner-1', { taskId: 'child-a' });
    expect(snapshot.outputTruncated).toBe(true);
    expect(snapshot.output?.length).toBe(8_000);
    expect(snapshot.output?.endsWith('END')).toBe(true);
  });

  test('hub_query_task returns a short stdout whole', () => {
    wire('short');
    const snapshot = hub.handleQueryTask('planner-1', { taskId: 'child-a' });
    expect(snapshot.output).toBe('short');
    expect(snapshot.outputTruncated).toBeUndefined();
  });

  test('hub_say records what the worker said on its task and refuses an empty line', () => {
    hub.workerRegistry.setTask('planner-1', 'task-p');
    expect(hub.handleSay('planner-1', { text: '  方案：三步，先后端再前端。  ' })).toEqual({ sent: true });
    const said = hub.eventLog.query({ type: 'worker_message' });
    expect(said).toHaveLength(1);
    expect(said[0].taskId).toBe('task-p');
    expect(said[0].data.text).toBe('方案：三步，先后端再前端。');
    expect(() => hub.handleSay('planner-1', { text: '   ' })).toThrow('text is required');
  });
});
