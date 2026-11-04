import { describe, expect, test } from 'bun:test';
import type { ClusterTask, ClusterWorkerRegistration } from '@qqbot/api-types';
import { buildRuns } from './runs';
import { buildBranches, elapsedFraction, layoutTopology, workerState } from './topology';
import type { RunWindow } from './window';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function task(id: string, patch: Partial<ClusterTask> = {}): ClusterTask {
  return {
    id,
    jobId: 'j1',
    project: 'demo',
    description: id,
    status: 'running',
    source: 'queue',
    createdAt: '2026-11-04T11:00:00Z',
    ...patch,
  };
}

function worker(id: string, patch: Partial<ClusterWorkerRegistration> = {}): ClusterWorkerRegistration {
  return {
    workerId: id,
    role: 'coder',
    project: 'demo',
    templateName: 'demo-template',
    status: 'active',
    lastSeen: NOW,
    syncCursor: 0,
    stats: { tasksCompleted: 0, tasksFailed: 0, totalReports: 0, registeredAt: NOW },
    ...patch,
  };
}

function branches(
  tasks: ClusterTask[],
  workers: ClusterWorkerRegistration[],
  seen: string[] = [],
  opts: { window: RunWindow; liveOnly: boolean; now: number } = { window: '24h', liveOnly: false, now: NOW },
) {
  const runs = buildRuns(
    tasks.map((t) => ({ task: seen.includes(t.id) ? { ...t, acknowledgedAt: '2026-11-04T11:59:00Z' } : t })),
    [],
    workers,
    NOW,
  );
  return buildBranches(runs, workers, opts);
}

describe('buildBranches', () => {
  test('a spawned run hangs under its parent', () => {
    const tree = branches([task('p'), task('c', { parentTaskId: 'p' })], []);
    expect(tree).toHaveLength(1);
    expect(tree[0].roots.map((r) => r.run.task.id)).toEqual(['p']);
    expect(tree[0].roots[0].children.map((r) => r.run.task.id)).toEqual(['c']);
  });

  test('a finished planner stays on the map while a child runs', () => {
    const planner = task('p', { status: 'completed', completedAt: '2026-11-04T11:30:00Z' });
    const tree = branches([planner, task('c', { parentTaskId: 'p' })], [], ['p']);
    expect(tree[0].roots[0].children).toHaveLength(1);
  });

  test('what ended inside the window stays on the map, seen or not', () => {
    const failed = task('f', { status: 'failed', completedAt: '2026-11-04T11:30:00Z' });
    expect(branches([failed], [], ['f'])[0].roots.map((r) => r.run.task.id)).toEqual(['f']);
    expect(branches([task('x', { status: 'cancelled' })], [])[0].roots.map((r) => r.run.task.id)).toEqual(['x']);
  });

  test('what ended before the window leaves the map', () => {
    const old = task('o', { status: 'completed', completedAt: '2026-11-01T11:30:00Z' });
    expect(branches([old], [], ['o'], { window: '24h', liveOnly: false, now: NOW })).toHaveLength(0);
    expect(branches([old], [], ['o'], { window: 'all', liveOnly: false, now: NOW })).toHaveLength(1);
  });

  test('liveOnly keeps the live and waiting runs and drops the ended ones', () => {
    const tree = branches(
      [
        task('r'),
        task('q', { status: 'pending' }),
        task('d', { status: 'completed', completedAt: '2026-11-04T11:30:00Z' }),
        task('f', { status: 'failed', completedAt: '2026-11-04T11:30:00Z' }),
      ],
      [],
      [],
      { window: 'all', liveOnly: true, now: NOW },
    );
    expect(tree[0].roots.map((r) => r.run.task.id)).toEqual(['r', 'q']);
  });

  test('a parent outside the window is kept when a child is on the map', () => {
    const planner = task('p', { status: 'completed', completedAt: '2026-11-01T11:30:00Z' });
    const tree = branches([planner, task('c', { parentTaskId: 'p' })], [], []);
    expect(tree[0].roots.map((r) => r.run.task.id)).toEqual(['p']);
    expect(tree[0].roots[0].children.map((r) => r.run.task.id)).toEqual(['c']);
  });

  test('a worker with no run is listed under its project, an exited one is not', () => {
    const tree = branches([], [worker('w1'), worker('w2', { status: 'exited' })]);
    expect(tree[0].idleWorkers.map((w) => w.workerId)).toEqual(['w1']);
  });
});

describe('layoutTopology', () => {
  const planner = task('p', { workerId: 'w1' });
  const child = task('c', { parentTaskId: 'p', workerId: 'w2' });
  const workers = [worker('w1'), worker('w2')];

  test('layers run left to right and every edge joins two placed nodes', () => {
    const { nodes, edges, width, height } = layoutTopology(branches([planner, child], workers), []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const x = (id: string) => byId.get(id)?.x ?? -1;
    expect(x('project:demo')).toBeLessThan(x('run:p'));
    expect(x('run:p')).toBeLessThan(x('run:c'));
    expect(x('run:c')).toBeLessThan(x('worker:w2'));
    for (const edge of edges) {
      expect(byId.has(edge.from) && byId.has(edge.to)).toBe(true);
    }
    for (const node of nodes) {
      expect(node.x + node.w).toBeLessThanOrEqual(width);
      expect(node.y + node.h).toBeLessThanOrEqual(height);
    }
  });

  test('nodes of one column never overlap', () => {
    const tree = branches([planner, child, task('s', { workerId: 'w3' }), task('q', { status: 'pending' })], [
      ...workers,
      worker('w3'),
    ]);
    const { nodes } = layoutTopology(tree, []);
    const columns = Map.groupBy(nodes, (n) => n.x);
    for (const column of columns.values()) {
      const sorted = [...column].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i].y).toBeGreaterThanOrEqual(sorted[i - 1].y + sorted[i - 1].h);
      }
    }
  });

  test('edges are rounded elbows that start and end on the node edges', () => {
    const { nodes, edges } = layoutTopology(branches([planner, child], workers), []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) {
        throw new Error('edge joins an unplaced node');
      }
      expect(edge.path.startsWith(`M${from.x + from.w} ${from.y + from.h / 2}`)).toBe(true);
      expect(edge.path.endsWith(`H${to.x}`)).toBe(true);
      const level = from.y + from.h / 2 === to.y + to.h / 2;
      expect(edge.path.includes('A')).toBe(!level);
    }
  });

  test('only the line from a run to a run it spawned is a spawn edge', () => {
    const { edges } = layoutTopology(branches([planner, child], workers), []);
    expect(edges.filter((e) => e.spawn).map((e) => e.id)).toEqual(['run:p>run:c']);
  });

  test('a run counts the runs it spawned', () => {
    const { nodes } = layoutTopology(branches([planner, child, task('lone')], workers), []);
    const childRuns = (id: string) => nodes.find((n) => n.id === id && n.kind === 'run');
    expect(childRuns('run:p')).toMatchObject({ childRuns: 1 });
    expect(childRuns('run:c')).toMatchObject({ childRuns: 0 });
    expect(childRuns('run:lone')).toMatchObject({ childRuns: 0 });
  });

  test('each project gets a band that covers its nodes and no other project’s', () => {
    const tree = branches(
      [planner, task('o', { project: 'other', workerId: 'w9' })],
      [...workers, worker('w9', { project: 'other' })],
    );
    const { nodes, bands } = layoutTopology(tree, []);
    expect(bands.map((b) => b.alias)).toEqual(['demo', 'other']);
    const inside = (b: { y: number; h: number }, n: { y: number; h: number }) =>
      n.y >= b.y && n.y + n.h <= b.y + b.h;
    const owner = (id: string) => bands.filter((b) => inside(b, nodes.find((n) => n.id === id) ?? { y: NaN, h: 0 }));
    for (const id of ['project:demo', 'run:p', 'worker:w1']) {
      expect(owner(id).map((b) => b.alias)).toEqual(['demo']);
    }
    for (const id of ['project:other', 'run:o', 'worker:w9']) {
      expect(owner(id).map((b) => b.alias)).toEqual(['other']);
    }
  });

  test('counts a worker’s locks', () => {
    const lock = { filePath: 'a.ts', workerId: 'w1', claimedAt: NOW, lastRenewed: NOW, ttl: 1000 };
    const { nodes } = layoutTopology(branches([planner], workers.slice(0, 1)), [lock]);
    expect(nodes.find((n) => n.kind === 'worker')).toMatchObject({ lockedFiles: 1 });
  });
});

test('elapsedFraction is a capped share of half an hour', () => {
  expect(elapsedFraction(0)).toBe(0);
  expect(elapsedFraction(15 * 60_000)).toBe(0.5);
  expect(elapsedFraction(2 * 60 * 60_000)).toBe(1);
  expect(elapsedFraction(-5)).toBe(0);
});

test('workerState follows the run it serves', () => {
  expect(workerState(undefined)).toBe('idle');
  const [run] = buildRuns([{ task: task('r') }], [], [], NOW);
  expect(workerState(run)).toBe('working');
  expect(workerState({ ...run, stage: 'asking' })).toBe('asking');
  expect(workerState({ ...run, stage: 'blocked' })).toBe('failed');
  expect(workerState({ ...run, stage: 'done' })).toBe('exited');
});
