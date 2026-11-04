import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClusterConfig } from '../../config';
import { createClusterTables } from '../../schema';
import { ContextHub } from '../ContextHub';

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
