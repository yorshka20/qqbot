import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClusterConfig } from '../../config';
import { createClusterTables } from '../../schema';
import type { HelpRequest, TaskRecord } from '../../types';
import { ContextHub, type SchedulerBridge } from '../ContextHub';

const JOB = 'job-1';

describe('hub_ask and hub_answer', () => {
  let dir: string;
  let db: Database;
  let hub: ContextHub;
  let tasks: Map<string, TaskRecord>;
  let toOwner: HelpRequest[];

  function addTask(id: string, role: 'coder' | 'planner', parentTaskId?: string): string {
    const workerId = `worker-${id}`;
    tasks.set(id, {
      id,
      jobId: JOB,
      parentTaskId,
      project: 'p',
      description: id,
      status: 'running',
      source: 'planner',
      createdAt: new Date().toISOString(),
      workerId,
    });
    hub.workerRegistry.register(workerId, { role, project: 'p', templateName: 'tpl', jobId: JOB });
    hub.bindWorker(workerId, id);
    return workerId;
  }

  const unread = (workerId: string) => hub.messageBox.getUnreadCount(workerId);
  const ask = (workerId: string, type: 'decision' | 'escalation' = 'decision') =>
    hub.handleAsk(workerId, { type, question: 'which one?', options: ['a', 'b'] });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-ask-'));
    db = new Database(':memory:');
    createClusterTables(db);
    tasks = new Map();
    toOwner = [];
    const config = parseClusterConfig({
      enabled: true,
      stateDir: dir,
      workerTemplates: { tpl: { type: 'claude-cli' } },
      projects: {},
    });
    if (!config) throw new Error('config');
    hub = new ContextHub(config, db, join(dir, 'tickets'));
    hub.setSchedulerBridge({ findTask: (id: string) => tasks.get(id) } as unknown as SchedulerBridge);
    hub.setAskListener((request) => toOwner.push(request));
  });

  afterEach(() => {
    hub.lockManager.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a child's question reaches its own planner once, and no other planner", () => {
    const planner = addTask('plan', 'planner');
    const stranger = addTask('other-plan', 'planner');
    const child = addTask('child', 'coder', 'plan');

    ask(child);

    expect(unread(planner)).toBe(1);
    expect(unread(stranger)).toBe(0);
    expect(toOwner).toEqual([]);
    expect(hub.getPendingHelpRequests()).toHaveLength(1);
  });

  test("a planner's question goes to the owner and never comes back to the planner", () => {
    const planner = addTask('plan', 'planner');
    addTask('other-plan', 'planner');

    const { askId } = ask(planner);

    expect(unread(planner)).toBe(0);
    expect(toOwner.map((r) => r.id)).toEqual([askId]);
  });

  test('an escalation skips the planner', () => {
    const planner = addTask('plan', 'planner');
    const child = addTask('child', 'coder', 'plan');

    ask(child, 'escalation');

    expect(unread(planner)).toBe(0);
    expect(toOwner).toHaveLength(1);
  });

  test('a question from a child whose planner is gone goes to the owner', () => {
    const planner = addTask('plan', 'planner');
    const child = addTask('child', 'coder', 'plan');
    hub.workerExited(planner);

    ask(child);

    expect(toOwner).toHaveLength(1);
  });

  test('the planner answers, which reaches the child and closes the question', () => {
    const planner = addTask('plan', 'planner');
    const child = addTask('child', 'coder', 'plan');
    const { askId } = ask(child);

    expect(hub.handleAnswer(planner, { askId, answer: 'a' })).toEqual({ delivered: true });

    expect(hub.getPendingHelpRequests()).toEqual([]);
    expect(unread(child)).toBe(1);
    expect(() => hub.handleAnswer(planner, { askId, answer: 'b' })).toThrow('already answered');
  });

  test('only the planner of the asking child can answer', () => {
    addTask('plan', 'planner');
    const stranger = addTask('other-plan', 'planner');
    const child = addTask('child', 'coder', 'plan');
    const sibling = addTask('sibling', 'coder', 'plan');
    const { askId } = ask(child);

    expect(() => hub.handleAnswer(stranger, { askId, answer: 'a' })).toThrow('one of your children');
    expect(() => hub.handleAnswer(sibling, { askId, answer: 'a' })).toThrow('planner-role');
    expect(() => hub.handleAnswer(stranger, { askId: 'missing', answer: 'a' })).toThrow('no question');
  });
});
