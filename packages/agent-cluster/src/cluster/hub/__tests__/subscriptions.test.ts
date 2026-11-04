import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClusterConfig } from '../../config';
import { createClusterTables } from '../../schema';
import type { TaskRecord } from '../../types';
import { ContextHub, type SchedulerBridge } from '../ContextHub';

const JOB = 'job-1';

let dir: string;
let db: Database;
let hub: ContextHub;
let tasks: Map<string, TaskRecord>;
let settled: Set<string>;

function openHub(): ContextHub {
  const config = parseClusterConfig({
    enabled: true,
    stateDir: dir,
    workerTemplates: { tpl: { type: 'claude-cli' } },
    projects: {},
  });
  if (!config) throw new Error('config');
  const opened = new ContextHub(config, db, join(dir, 'tickets'));
  opened.setSchedulerBridge({
    findTask: (id: string) => tasks.get(id),
    isTaskSettled: (id: string) => settled.has(id),
    taskInboxed: () => {},
  } as unknown as SchedulerBridge);
  return opened;
}

/** A running task with a registered worker `worker-<id>`; pass `worker: false` for one still queued. */
function addTask(id: string, opts: { jobId?: string; worker?: boolean } = {}): TaskRecord {
  const jobId = opts.jobId ?? JOB;
  const hasWorker = opts.worker !== false;
  const task: TaskRecord = {
    id,
    jobId,
    project: 'p',
    description: id,
    status: hasWorker ? 'running' : 'pending',
    source: 'planner',
    createdAt: new Date().toISOString(),
    workerId: hasWorker ? `worker-${id}` : undefined,
  };
  tasks.set(id, task);
  if (hasWorker) {
    hub.workerRegistry.register(`worker-${id}`, { role: 'coder', project: 'p', templateName: 'tpl', jobId });
    hub.bindWorker(`worker-${id}`, id);
  }
  return task;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-subscriptions-'));
  db = new Database(':memory:');
  createClusterTables(db);
  tasks = new Map();
  settled = new Set();
  hub = openHub();
});

afterEach(() => {
  hub.lockManager.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hub_subscribe', () => {
  test('subscriptions survive a restart, and an unsubscribe does too', () => {
    addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'], files: ['src/**/*.ts', './docs/a.md'], branch: true });

    hub.lockManager.stop();
    hub = openHub();
    hub.workerRegistry.hydrateFromDb();
    expect(hub.subscriptions.of('b')).toEqual({
      tasks: ['a'],
      files: ['docs/a.md', 'src/**/*.ts'],
      branch: true,
      dependsOn: [],
    });

    const { subscriptions } = hub.handleUnsubscribe('worker-b', { files: ['src/**/*.ts'], branch: true });
    expect(subscriptions).toEqual({ tasks: ['a'], files: ['docs/a.md'], branch: false, dependsOn: [] });

    hub.lockManager.stop();
    hub = openHub();
    expect(hub.subscriptions.of('b').files).toEqual(['docs/a.md']);
  });

  test('unsubscribing without naming anything drops every interest', () => {
    addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'], branch: true });
    expect(hub.handleUnsubscribe('worker-b', {}).subscriptions).toEqual({
      tasks: [],
      files: [],
      branch: false,
      dependsOn: [],
    });
  });

  test('a task in another job is refused, the same way as one that does not exist', () => {
    addTask('b');
    addTask('stranger', { jobId: 'job-2' });
    expect(() => hub.handleSubscribe('worker-b', { tasks: ['stranger'] })).toThrow('not in your job');
    expect(() => hub.handleSubscribe('worker-b', { tasks: ['nobody'] })).toThrow('not in your job');
    expect(hub.subscriptions.of('b').tasks).toEqual([]);
  });

  test('a subscription that could never match is refused', () => {
    addTask('b');
    expect(() => hub.handleSubscribe('worker-b', { tasks: ['b'] })).toThrow('itself');
    expect(() => hub.handleSubscribe('worker-b', {})).toThrow('at least one');
    expect(() => hub.handleSubscribe('worker-b', { files: ['/abs/path.ts'] })).toThrow('repo-relative');
    expect(() => hub.handleSubscribe('worker-b', { files: ['../outside.ts'] })).toThrow('repo-relative');
  });

  test('a worker whose process exited loses its subscriptions', () => {
    addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });
    hub.workerExited('worker-b');
    expect(hub.subscriptions.of('b').tasks).toEqual([]);
  });

  test('the console sees the whole set on every change, and the task timeline keeps it', () => {
    addTask('a');
    addTask('b');
    const seen: Array<[string, unknown]> = [];
    hub.addSSESubscriber({ send: (event, data) => seen.push([event, data]), close: () => {} });

    hub.handleSubscribe('worker-b', { tasks: ['a'] });

    const subscriptions = { tasks: ['a'], files: [], branch: false, dependsOn: [] };
    expect(seen).toEqual([['task_subscribed', { taskId: 'b', jobId: JOB, subscriptions }]]);
    expect(hub.eventLog.query({ taskId: 'b', type: 'task_subscribed' })[0].data).toEqual({ subscriptions });
  });
});

describe('events reaching a subscriber', () => {
  test('a lock release wakes a file subscriber with the files it follows', async () => {
    addTask('a');
    addTask('b');
    hub.handleClaim('worker-a', { intent: 'edit', files: ['src/x.ts', 'src/y.ts', 'README.md'] });
    hub.handleSubscribe('worker-b', { files: ['src/**'] });

    const waiting = hub.handleWait('worker-b', { timeoutMs: 5_000 });
    await Bun.sleep(10);
    hub.handleReport('worker-a', { status: 'failed', summary: 'gave up' });

    const result = await waiting;
    expect(result.reason).toBe('event');
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({
      kind: 'lock_released',
      taskId: 'a',
      files: ['src/x.ts', 'src/y.ts'],
    });
  });

  test('a granted lock on a followed file wakes the subscriber, but a renewal and its own lock do not', async () => {
    addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { files: ['src/x.ts'] });

    hub.handleClaim('worker-b', { intent: 'edit', files: ['src/x.ts'] });
    expect(hub.messageBox.getUnreadCount('worker-b')).toBe(0);
    hub.lockManager.releaseAll('worker-b');
    expect(hub.messageBox.getUnreadCount('worker-b')).toBe(0);

    hub.handleClaim('worker-a', { intent: 'edit', files: ['src/x.ts'] });
    hub.handleClaim('worker-a', { intent: 'again', files: ['src/x.ts'] });
    expect(hub.messageBox.consume('worker-b')).toMatchObject([{ kind: 'lock_acquired', taskId: 'a' }]);
  });

  test('what a worker claims under never moves it off the task it was started for', () => {
    addTask('a');
    hub.handleClaim('worker-a', { intent: 'edit', files: ['src/x.ts'] });
    expect(hub.workerRegistry.get('worker-a')?.currentTaskId).toBe('a');
    expect(hub.lockManager.getActiveLocks()[0]).toMatchObject({ taskId: 'a', workerId: 'worker-a' });
  });

  test('a lock in another job says nothing to this one', () => {
    addTask('b');
    addTask('stranger', { jobId: 'job-2' });
    hub.handleSubscribe('worker-b', { files: ['src/x.ts'] });
    hub.handleClaim('worker-stranger', { intent: 'edit', files: ['src/x.ts'] });
    expect(hub.messageBox.getUnreadCount('worker-b')).toBe(0);
  });

  test('progress carries the summary and next steps, and nothing else of the report', async () => {
    addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });

    hub.handleReport('worker-a', {
      status: 'working',
      summary: 'schema done',
      nextSteps: 'write the handler',
      filesModified: ['src/secret-detail.ts'],
    });

    const result = await hub.handleWait('worker-b', { timeoutMs: 5_000 });
    expect(result.reason).toBe('event');
    expect(result.updates).toEqual([
      { kind: 'worker_progress', taskId: 'a', summary: 'schema done Next: write the handler' },
    ]);
  });

  test('a merge names the files; a file subscriber gets only its own as files_changed', async () => {
    const a = addTask('a');
    a.diffSummary = 'added the tag model';
    addTask('b');
    addTask('c');
    addTask('d');
    addTask('e');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });
    hub.handleSubscribe('worker-c', { files: ['src/*.ts'] });
    hub.handleSubscribe('worker-d', { branch: true, files: ['src/*.ts'] });
    hub.handleSubscribe('worker-e', { files: ['other/**'] });

    const files = ['src/tag.ts', 'docs/tag.md'];
    hub.taskMerged(a, { branch: 'cluster/j-a', integrationBranch: 'cluster/j', before: 'b0', head: 'h1', files });

    const merged = {
      kind: 'task_merged' as const,
      taskId: 'a',
      branch: 'cluster/j',
      summary: 'Landed on cluster/j, 2 file(s) changed. added the tag model',
      files,
    };
    expect(hub.messageBox.consume('worker-b')).toEqual([merged]);
    expect(hub.messageBox.consume('worker-d')).toEqual([merged]);
    expect(hub.messageBox.consume('worker-c')).toMatchObject([
      { kind: 'files_changed', taskId: 'a', branch: 'cluster/j', files: ['src/tag.ts'] },
    ]);
    expect(hub.messageBox.getUnreadCount('worker-a')).toBe(0);
    expect(hub.messageBox.getUnreadCount('worker-e')).toBe(0);
  });

  test('a big merge is capped on the way out but still matches a file past the cap', () => {
    const a = addTask('a');
    addTask('b');
    addTask('c');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });
    hub.handleSubscribe('worker-c', { files: ['last.ts'] });
    const files = [...Array.from({ length: 200 }, (_, i) => `gen/${i}.ts`), 'last.ts'];

    hub.taskMerged(a, { branch: 'cluster/j-a', integrationBranch: 'cluster/j', before: 'b0', head: 'h1', files });

    const [merged] = hub.messageBox.consume('worker-b') as Array<{ summary: string; files: string[] }>;
    expect(merged.files).toHaveLength(50);
    expect(merged.summary).toContain('201 file(s)');
    expect(hub.messageBox.consume('worker-c')).toMatchObject([{ kind: 'files_changed', files: ['last.ts'] }]);
    expect(hub.eventLog.query({ taskId: 'a', type: 'task_merged' })[0].data).toMatchObject({ filesTotal: 201 });
  });

  test('an outcome reaches the subscriber, with the reason when the task did not succeed', () => {
    const a = addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });

    a.status = 'blocked';
    a.branch = 'cluster/j-a';
    a.error = 'Merge conflict landing cluster/j-a on cluster/j:\nshared.txt';
    hub.publishTaskOutcome(a);

    expect(hub.messageBox.consume('worker-b')).toEqual([
      {
        kind: 'task_blocked',
        taskId: 'a',
        branch: 'cluster/j-a',
        summary: 'Merge conflict landing cluster/j-a on cluster/j: shared.txt',
      },
    ]);
  });

  test('hub_sync sees subscribed events too, and they are delivered once', () => {
    const a = addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });
    a.status = 'completed';
    hub.publishTaskOutcome(a);

    const { updates } = hub.handleSync('worker-b');
    expect(updates.filter((u) => 'kind' in u)).toMatchObject([{ kind: 'task_completed', taskId: 'a' }]);
    expect(hub.handleSync('worker-b').updates.filter((u) => 'kind' in u)).toEqual([]);
  });

  test('an event already queued answers hub_wait at once, and a real message outranks it', async () => {
    const a = addTask('a');
    addTask('b');
    hub.handleSubscribe('worker-b', { tasks: ['a'] });
    a.status = 'completed';
    hub.publishTaskOutcome(a);
    expect((await hub.handleWait('worker-b', { timeoutMs: 5_000 })).reason).toBe('event');

    hub.publishTaskOutcome(a);
    hub.messageBox.send('worker-b', 'owner', 'stop', 'directive');
    const both = await hub.handleWait('worker-b', { timeoutMs: 5_000 });
    expect(both.reason).toBe('message');
    expect(both.updates).toHaveLength(2);
  });

  test('subscribing after the fact catches up on what the task already did, once', () => {
    const a = addTask('a');
    addTask('b');
    a.diffSummary = 'added the tag model';
    a.mergedAt = new Date().toISOString();
    a.status = 'completed';
    hub.taskMerged(a, {
      branch: 'cluster/j-a',
      integrationBranch: 'cluster/j',
      before: 'b0',
      head: 'h1',
      files: ['src/tag.ts'],
    });
    settled.add('a');

    expect(hub.handleSubscribe('worker-b', { tasks: ['a'] }).caughtUp).toBe(2);
    expect(hub.messageBox.consume('worker-b')).toMatchObject([
      { kind: 'task_merged', taskId: 'a', branch: 'cluster/j', files: ['src/tag.ts'] },
      { kind: 'task_completed', taskId: 'a', summary: 'added the tag model' },
    ]);

    expect(hub.handleSubscribe('worker-b', { tasks: ['a'] }).caughtUp).toBe(0);
    expect(hub.messageBox.getUnreadCount('worker-b')).toBe(0);
  });

  test('a task with no worker yet keeps outcomes for its worker and skips what will be stale', () => {
    const a = addTask('a');
    const b = addTask('b', { worker: false });
    hub.preSubscribe(b, { tasks: ['a'], files: ['src/x.ts'] });
    expect(hub.taskDependencies('b')).toEqual(['a']);

    hub.handleReport('worker-a', { status: 'working', summary: 'halfway', nextSteps: 'finish' });
    hub.handleClaim('worker-a', { intent: 'edit', files: ['src/x.ts'] });
    a.status = 'completed';
    hub.publishTaskOutcome(a);

    b.workerId = 'worker-b';
    hub.workerRegistry.register('worker-b', { role: 'coder', project: 'p', templateName: 'tpl', jobId: JOB });
    hub.bindWorker('worker-b', 'b');
    expect(hub.messageBox.consume('worker-b')).toMatchObject([{ kind: 'task_completed', taskId: 'a' }]);
  });

  test('what a queued task was told survives a restart', () => {
    const a = addTask('a');
    const b = addTask('b', { worker: false });
    hub.preSubscribe(b, { tasks: ['a'] });
    a.status = 'completed';
    hub.publishTaskOutcome(a);

    hub.lockManager.stop();
    hub = openHub();
    b.workerId = 'worker-b';
    hub.bindWorker('worker-b', 'b');
    expect(hub.messageBox.consume('worker-b')).toMatchObject([{ kind: 'task_completed', taskId: 'a' }]);
  });

  test('a task that settles without ever having a worker leaves nothing behind', () => {
    const a = addTask('a');
    const b = addTask('b', { worker: false });
    hub.preSubscribe(b, { tasks: ['a'] });
    a.status = 'completed';
    hub.publishTaskOutcome(a);

    hub.taskSettled('b');

    expect(hub.subscriptions.of('b').tasks).toEqual([]);
    expect(hub.messageBox.getUnreadCount('task:b')).toBe(0);
  });
});

describe('hub_message to a sibling', () => {
  test('a sibling task id reaches its worker, or its inbox while it has none', () => {
    addTask('a');
    addTask('b');
    addTask('c', { worker: false });

    hub.handleMessage('worker-a', { to: 'b', content: 'the column is named tag_id', priority: 'info' });
    hub.handleMessage('worker-a', { to: 'c', content: 'use tag_id', priority: 'info' });

    expect(hub.messageBox.consume('worker-b')).toMatchObject([{ type: 'message', summary: 'the column is named tag_id' }]);
    expect(hub.messageBox.getUnreadCount('task:c')).toBe(1);
  });
});

describe('hub_spawn validation', () => {
  function plannerWith(submit: () => TaskRecord | null): void {
    addTask('planner');
    hub.workerRegistry.register('worker-planner', { role: 'planner' });
    hub.setSchedulerBridge({
      findTask: (id: string) => tasks.get(id),
      isTaskSettled: (id: string) => settled.has(id),
      submitChildTask: async () => submit(),
      taskInboxed: () => {},
    } as unknown as SchedulerBridge);
  }

  const spawn = (subscribe: { tasks: string[] }) =>
    hub.handleSpawn('worker-planner', { description: 'x', template: 'tpl', subscribe });

  test('a dependency in another job, or the planner itself, never reaches the scheduler', async () => {
    let submitted = 0;
    plannerWith(() => {
      submitted += 1;
      return null;
    });
    addTask('stranger', { jobId: 'job-2' });

    await expect(spawn({ tasks: ['stranger'] })).rejects.toThrow('not in your job');
    await expect(spawn({ tasks: ['planner'] })).rejects.toThrow('itself');
    expect(submitted).toBe(0);
  });

  test('a dependency that already failed is refused at spawn', async () => {
    plannerWith(() => null);
    const a = addTask('a');
    a.status = 'failed';
    settled.add('a');

    await expect(spawn({ tasks: ['a'] })).rejects.toThrow('ended failed');
  });
});

describe('over the MCP transport', () => {
  async function callTool(workerId: string, name: string, args: Record<string, unknown>) {
    const response = await hub.mcpServer.handleRequest(
      new Request('http://hub/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Worker-Id': workerId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
    );
    const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '));
    const { result } = JSON.parse((data as string).slice('data: '.length));
    return { isError: result.isError === true, text: result.content[0].text as string };
  }

  test('hub_subscribe and hub_unsubscribe validate and answer through the tool layer', async () => {
    addTask('a');
    addTask('b');

    const subscribed = await callTool('worker-b', 'hub_subscribe', { tasks: ['a'], files: ['src/**'], branch: true });
    expect(subscribed.isError).toBe(false);
    expect(JSON.parse(subscribed.text).subscriptions).toMatchObject({ tasks: ['a'], files: ['src/**'], branch: true });

    const unsubscribed = await callTool('worker-b', 'hub_unsubscribe', { branch: true });
    expect(JSON.parse(unsubscribed.text).subscriptions.branch).toBe(false);

    expect((await callTool('worker-b', 'hub_subscribe', { files: 'src/**' })).isError).toBe(true);
  });

  test('hub_spawn passes a nested subscribe through to the scheduler', async () => {
    addTask('planner');
    addTask('a');
    hub.workerRegistry.register('worker-planner', { role: 'planner' });
    let received: unknown;
    hub.setSchedulerBridge({
      findTask: (id: string) => tasks.get(id),
      isTaskSettled: () => false,
      submitChildTask: async (opts: { subscribe?: unknown }) => {
        received = opts.subscribe;
        return addTask('child', { worker: false });
      },
      taskInboxed: () => {},
    } as unknown as SchedulerBridge);

    const spawned = await callTool('worker-planner', 'hub_spawn', {
      description: 'x',
      template: 'tpl',
      subscribe: { tasks: ['a'], branch: true },
    });

    expect(spawned.isError).toBe(false);
    expect(received).toEqual({ tasks: ['a'], files: [], branch: true });
  });
});

describe('a worker stays bound to its task', () => {
  test('hub_message cannot reach a task or worker of another job', () => {
    addTask('a');
    addTask('stranger', { jobId: 'job-2' });
    const message = { content: 'fact', priority: 'info' as const };
    expect(() => hub.handleMessage('worker-a', { to: 'stranger', ...message })).toThrow(/not in your job/);
    expect(() => hub.handleMessage('worker-a', { to: 'worker-stranger', ...message })).toThrow(/not in your job/);
    expect(hub.messageBox.getUnreadCount('worker-stranger')).toBe(0);
  });

  test('what a worker never read goes with it', () => {
    addTask('a');
    addTask('b');
    hub.handleMessage('worker-a', { to: 'b', content: 'fact', priority: 'info' });
    expect(hub.messageBox.getUnreadCount('worker-b')).toBe(1);
    hub.workerExited('worker-b');
    expect(hub.messageBox.getUnreadCount('worker-b')).toBe(0);
  });
});
