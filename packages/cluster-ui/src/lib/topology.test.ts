import { describe, expect, test } from 'bun:test';
import type { ClusterTask, ClusterWorkerRegistration } from '@qqbot/api-types';
import { buildRuns } from './runs';
import { buildBranches, layoutTopology, workerState } from './topology';

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

function branches(tasks: ClusterTask[], workers: ClusterWorkerRegistration[], seen: string[] = []) {
  const seenSet = new Set(seen);
  const runs = buildRuns(
    tasks.map((t) => ({ task: t })),
    [],
    workers,
    seenSet,
    NOW,
  );
  return buildBranches(runs, workers, seenSet);
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

  test('what is over and seen leaves the map', () => {
    const failed = task('f', { status: 'failed', completedAt: '2026-11-04T11:30:00Z' });
    expect(branches([failed], [], ['f'])).toHaveLength(0);
    expect(branches([task('x', { status: 'cancelled' })], [])).toHaveLength(0);
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

  test('counts a worker’s locks', () => {
    const lock = { filePath: 'a.ts', workerId: 'w1', claimedAt: NOW, lastRenewed: NOW, ttl: 1000 };
    const { nodes } = layoutTopology(branches([planner], workers.slice(0, 1)), [lock]);
    expect(nodes.find((n) => n.kind === 'worker')).toMatchObject({ lockedFiles: 1 });
  });
});

test('workerState follows the run it serves', () => {
  expect(workerState(undefined)).toBe('idle');
  const [run] = buildRuns([{ task: task('r') }], [], [], new Set(), NOW);
  expect(workerState(run)).toBe('working');
  expect(workerState({ ...run, stage: 'asking' })).toBe('asking');
  expect(workerState({ ...run, stage: 'blocked' })).toBe('failed');
  expect(workerState({ ...run, stage: 'done' })).toBe('exited');
});
