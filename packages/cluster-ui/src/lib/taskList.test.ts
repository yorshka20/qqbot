import { describe, expect, test } from 'bun:test';
import type { ClusterHelpRequest, ClusterTask } from '@qqbot/api-types';
import type { Run } from './runs';
import type { Stage } from './stage';
import { buildTaskList, pathOfRun } from './taskList';

const NOW = new Date(2026, 10, 4, 12, 0).getTime();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface RunSpec {
  id: string;
  stage?: Stage;
  parent?: string;
  title?: string;
  model?: string;
  at?: number;
  acknowledged?: boolean;
}

function run(spec: RunSpec): Run {
  const stage = spec.stage ?? 'done';
  const at = spec.at ?? NOW - HOUR;
  const status: ClusterTask['status'] =
    stage === 'running' || stage === 'asking'
      ? 'running'
      : stage === 'queued'
        ? 'pending'
        : stage === 'failed'
          ? 'failed'
          : stage === 'blocked'
            ? 'blocked'
            : stage === 'cancelled'
              ? 'cancelled'
              : 'completed';
  const live = status === 'running' || status === 'pending';
  const task: ClusterTask = {
    id: spec.id,
    jobId: `job-${spec.id}`,
    project: 'demo',
    description: spec.title ?? spec.id,
    status,
    source: 'api',
    createdAt: new Date(at).toISOString(),
    completedAt: live ? undefined : new Date(at).toISOString(),
    parentTaskId: spec.parent,
    model: spec.model,
    acknowledgedAt: spec.acknowledged ? new Date(at).toISOString() : undefined,
  };
  const asks: ClusterHelpRequest[] =
    stage === 'asking'
      ? [
          {
            id: `ask-${spec.id}`,
            workerId: 'w1',
            taskId: spec.id,
            type: 'decision',
            question: '选哪个？',
            status: 'pending',
            createdAt: new Date(at).toISOString(),
          },
        ]
      : [];
  return { task, stage, title: spec.title ?? spec.id, asks, since: at };
}

const NONE: ReadonlySet<string> = new Set();
const ids = (items: { root: Run }[]) => items.map((item) => item.root.task.id);

describe('buildTaskList', () => {
  test('groups descendants under the root in spawn order', () => {
    const runs = [
      run({ id: 'root', stage: 'running' }),
      run({ id: 'c2', parent: 'root', stage: 'running', at: NOW - 10 * 60_000 }),
      run({ id: 'c1', parent: 'root', stage: 'done', at: NOW - 30 * 60_000 }),
      run({ id: 'gc', parent: 'c1', stage: 'done', at: NOW - 20 * 60_000 }),
    ];
    const { active } = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: NONE });
    expect(ids(active)).toEqual(['root']);
    expect(active[0].children.map((c) => c.task.id)).toEqual(['c1', 'gc', 'c2']);
  });

  test('a child of another task stays out of this tree', () => {
    const runs = [run({ id: 'a', stage: 'running' }), run({ id: 'b', stage: 'running' }), run({ id: 'b1', parent: 'b', stage: 'running' })];
    const { active } = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: NONE });
    const a = active.find((item) => item.root.task.id === 'a');
    expect(a?.children).toEqual([]);
  });

  test('a run whose parent is not loaded becomes a root', () => {
    const { active } = buildTaskList([run({ id: 'orphan', parent: 'missing', stage: 'running' })], { now: NOW, query: '', historyWindow: '7d', pinned: NONE });
    expect(ids(active)).toEqual(['orphan']);
  });

  test('a child question surfaces on the root', () => {
    const runs = [run({ id: 'root', stage: 'running' }), run({ id: 'kid', parent: 'root', stage: 'asking' })];
    const { active } = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: NONE });
    expect(active[0].attention).toBe('asking');
  });

  test('an unacknowledged failure needs attention, an acknowledged one is history', () => {
    const runs = [run({ id: 'bad', stage: 'failed' }), run({ id: 'seen', stage: 'failed', acknowledged: true })];
    const { active, history } = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: NONE });
    expect(active.map((i) => [i.root.task.id, i.attention])).toEqual([['bad', 'failed']]);
    expect(ids(history)).toEqual(['seen']);
  });

  test('ended families are history, newest first, within seven days', () => {
    const runs = [
      run({ id: 'old', at: NOW - 8 * DAY }),
      run({ id: 'older-ok', at: NOW - 3 * DAY }),
      run({ id: 'newer', at: NOW - 1 * DAY }),
    ];
    const { active, history } = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: NONE });
    expect(active).toEqual([]);
    expect(ids(history)).toEqual(['newer', 'older-ok']);
  });

  test('the history window decides how far back ended runs reach', () => {
    const runs = [run({ id: 'old', at: NOW - 8 * DAY }), run({ id: 'recent', at: NOW - 1 * DAY })];
    expect(ids(buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: NONE }).history)).toEqual(['recent']);
    expect(ids(buildTaskList(runs, { now: NOW, query: '', historyWindow: 'all', pinned: NONE }).history)).toEqual(['recent', 'old']);
  });

  test('a query matching a child keeps the whole tree', () => {
    const runs = [
      run({ id: 'root', title: '重构侧栏', stage: 'running' }),
      run({ id: 'kid', parent: 'root', title: '写迁移脚本', stage: 'running' }),
      run({ id: 'other', title: '无关任务', stage: 'running' }),
    ];
    const { active } = buildTaskList(runs, { now: NOW, query: '迁移', historyWindow: '7d', pinned: NONE });
    expect(ids(active)).toEqual(['root']);
    expect(active[0].children.map((c) => c.task.id)).toEqual(['kid']);
  });

  test('the query is case-insensitive and also matches the model', () => {
    const runs = [
      run({ id: 'x', title: 'Fix Build', stage: 'running' }),
      run({ id: 'y', title: 'other', stage: 'running', model: 'claude-opus-5-5' }),
    ];
    expect(ids(buildTaskList(runs, { now: NOW, query: 'fix build', historyWindow: '7d', pinned: NONE }).active)).toEqual(['x']);
    expect(ids(buildTaskList(runs, { now: NOW, query: 'OPUS', historyWindow: '7d', pinned: NONE }).active)).toEqual(['y']);
  });
});

describe('buildTaskList pinned', () => {
  test('a pinned ended run lands in pinned and not in history', () => {
    const runs = [run({ id: 'p' }), run({ id: 'q' })];
    const list = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: new Set(['p']) });
    expect(ids(list.pinned)).toEqual(['p']);
    expect(ids(list.history)).toEqual(['q']);
  });

  test('a pinned run stays past the history window', () => {
    const runs = [run({ id: 'old', at: NOW - 8 * DAY })];
    const list = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: new Set(['old']) });
    expect(ids(list.pinned)).toEqual(['old']);
  });

  test('a pinned active run leaves the active group', () => {
    const runs = [run({ id: 'live', stage: 'running' })];
    const list = buildTaskList(runs, { now: NOW, query: '', historyWindow: '7d', pinned: new Set(['live']) });
    expect(ids(list.pinned)).toEqual(['live']);
    expect(list.active).toEqual([]);
  });

  test('the search filters pinned runs too', () => {
    const runs = [run({ id: 'p', title: '甲' })];
    const list = buildTaskList(runs, { now: NOW, query: '乙', historyWindow: '7d', pinned: new Set(['p']) });
    expect(list.pinned).toEqual([]);
  });

  test('an unknown pinned id is ignored', () => {
    const list = buildTaskList([run({ id: 'a' })], { now: NOW, query: '', historyWindow: '7d', pinned: new Set(['gone']) });
    expect(list.pinned).toEqual([]);
    expect(ids(list.history)).toEqual(['a']);
  });
});

describe('pathOfRun', () => {
  test('a root opens its task, a descendant its place under the root', () => {
    const runs = [run({ id: 'r', stage: 'running' }), run({ id: 'k', parent: 'r' }), run({ id: 'g', parent: 'k' })];
    expect(pathOfRun(runs[0], runs)).toBe('/t/r');
    expect(pathOfRun(runs[2], runs)).toBe('/t/r/w/g');
    expect(pathOfRun(run({ id: 'o', parent: 'gone' }), runs)).toBe('/t/o');
  });
});
