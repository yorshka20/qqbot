import { describe, expect, test } from 'bun:test';
import type { ClusterTask } from '@qqbot/api-types';
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

const graphOf = (rootId: string, tasks: ClusterTask[], children: Array<{ id: string; dependsOn: string[] }> = []) =>
  buildTaskGraph(rootId, tasks, (t) => stageOfStatus(t.status), children);

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

  test('dependsOn adds a dependency edge between tasks in the graph, and nothing for strangers', () => {
    const graph = graphOf(
      'r',
      [task('r'), task('a', { parentTaskId: 'r' }), task('b', { parentTaskId: 'r' })],
      [
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a', 'ghost'] },
      ],
    );
    const deps = graph.edges.filter((e) => e.kind === 'dependency');
    expect(deps.map((e) => [e.source, e.target])).toEqual([['a', 'b']]);
    expect(graph.edges.filter((e) => e.kind === 'child')).toHaveLength(2);
  });

  test('there are no branch nodes', () => {
    const graph = graphOf('r', [task('r', { mergedAt: '2026-11-04T11:30:00Z' }), task('a', { parentTaskId: 'r' })]);
    expect(graph.nodes.every((n) => n.kind === 'task')).toBe(true);
  });
});
