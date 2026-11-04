import { describe, expect, test } from 'bun:test';
import type { ClusterJob, ClusterTask } from '@qqbot/api-types';
import { stageOfStatus } from './stage';
import { buildTaskGraph } from './taskGraph';

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

const graphOf = (rootId: string, tasks: ClusterTask[], job?: ClusterJob) =>
  buildTaskGraph(rootId, tasks, (t) => stageOfStatus(t.status), job);

describe('buildTaskGraph', () => {
  test('a lone root is one node and no edges', () => {
    const graph = graphOf('r', [task('r')]);
    expect(graph.nodes.map((n) => n.id)).toEqual(['r']);
    expect(graph.edges).toEqual([]);
  });

  test('another task tree never enters the graph', () => {
    const graph = graphOf('r', [
      task('r'),
      task('a', { parentTaskId: 'r' }),
      task('other'),
      task('other-child', { parentTaskId: 'other' }),
    ]);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'r']);
  });

  test('grandchildren and finished runs are included', () => {
    const graph = graphOf('r', [
      task('r'),
      task('a', { parentTaskId: 'r', status: 'completed' }),
      task('b', { parentTaskId: 'a', status: 'failed' }),
    ]);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'r']);
    expect(graph.edges.map((e) => e.id).sort()).toEqual(['a->b', 'r->a']);
    expect(graph.nodes.find((n) => n.id === 'b')?.stage).toBe('failed');
  });

  test('duplicate tasks collapse to one node', () => {
    const graph = graphOf('r', [task('r'), task('a', { parentTaskId: 'r' }), task('a', { parentTaskId: 'r' })]);
    expect(graph.nodes).toHaveLength(2);
  });

  test('a parent cycle terminates', () => {
    const graph = graphOf('r', [task('r', { parentTaskId: 'a' }), task('a', { parentTaskId: 'r' })]);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'r']);
    expect(graph.edges).toHaveLength(1);
  });

  test('an unknown root gives an empty graph', () => {
    expect(graphOf('missing', [task('r')])).toEqual({ nodes: [], edges: [] });
  });

  test('coordinates are finite, siblings do not overlap and the root is leftmost', () => {
    const graph = graphOf('r', [
      task('r'),
      task('a', { parentTaskId: 'r' }),
      task('b', { parentTaskId: 'r' }),
      task('c', { parentTaskId: 'r' }),
    ]);
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    const root = graph.nodes.find((n) => n.id === 'r');
    const children = graph.nodes.filter((n) => n.id !== 'r').sort((p, q) => p.y - q.y);
    for (const child of children) {
      expect(child.x).toBeGreaterThan(root?.x ?? 0);
    }
    for (let i = 1; i < children.length; i++) {
      expect(children[i].y).toBeGreaterThanOrEqual(children[i - 1].y + children[i - 1].height);
    }
  });

  test('the job runs on to its branches: merged children reach integration, a landed job reaches base', () => {
    const job = { integrationBranch: 'cluster/j1', baseBranch: 'master', landedAt: '2026-11-04T12:00:00Z' } as ClusterJob;
    const graph = graphOf(
      'r',
      [
        task('r', { status: 'completed' }),
        task('a', { parentTaskId: 'r', status: 'completed', mergedAt: '2026-11-04T11:30:00Z' }),
        task('b', { parentTaskId: 'r', status: 'running' }),
        task('c', { parentTaskId: 'r', status: 'failed' }),
      ],
      job,
    );

    const edge = (source: string, target: string) => graph.edges.find((e) => e.source === source && e.target === target);
    expect(edge('a', 'branch:integration')?.pending).toBe(false);
    expect(edge('b', 'branch:integration')?.pending).toBe(true);
    expect(edge('c', 'branch:integration')).toBeUndefined();
    expect(edge('r', 'branch:integration')).toBeUndefined();
    expect(edge('branch:integration', 'branch:base')?.pending).toBe(false);
    expect(graph.nodes.find((n) => n.id === 'branch:base')).toMatchObject({ branch: 'master', caption: '已合入' });
  });

  test('a job with no children delivers from its root, and a failed landing says so', () => {
    const job = { integrationBranch: 'cluster/j1', baseBranch: 'master', landError: 'conflict' } as ClusterJob;
    const graph = graphOf('r', [task('r', { status: 'blocked', mergedAt: '2026-11-04T11:30:00Z' })], job);

    expect(graph.edges.map((e) => e.id)).toContain('r->branch:integration');
    expect(graph.edges.find((e) => e.target === 'branch:base')?.pending).toBe(true);
    expect(graph.nodes.find((n) => n.id === 'branch:base')).toMatchObject({ caption: '合入失败', reached: false });
  });
});
