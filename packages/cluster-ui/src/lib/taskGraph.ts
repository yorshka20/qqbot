import dagre from '@dagrejs/dagre';
import type { ClusterTask } from '@qqbot/api-types';
import type { Stage } from './stage';

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 52;

interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskGraphTaskNode extends Placed {
  kind: 'task';
  task: ClusterTask;
  stage: Stage;
}

export type TaskGraphNode = TaskGraphTaskNode;

export interface TaskGraphEdge {
  id: string;
  source: string;
  target: string;
  /** `child` is spawned-by; `dependency` is a sibling that had to land first. */
  kind: 'child' | 'dependency';
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
}

/**
 * The task tree: the root, its descendants, and the dependency edges between siblings.
 * `tasks` may hold unrelated runs; only the root and its descendants enter the graph.
 */
export function buildTaskGraph(
  rootId: string,
  tasks: ClusterTask[],
  stageOf: (task: ClusterTask) => Stage,
  children: ReadonlyArray<{ id: string; dependsOn: string[] }>,
): TaskGraph {
  const byId = new Map<string, ClusterTask>();
  const childrenOf = new Map<string, ClusterTask[]>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      continue;
    }
    byId.set(task.id, task);
    if (task.parentTaskId) {
      const siblings = childrenOf.get(task.parentTaskId);
      if (siblings) {
        siblings.push(task);
      } else {
        childrenOf.set(task.parentTaskId, [task]);
      }
    }
  }

  const root = byId.get(rootId);
  if (!root) {
    return { nodes: [], edges: [] };
  }

  const members: ClusterTask[] = [];
  const edges: TaskGraphEdge[] = [];
  const seen = new Set<string>([rootId]);
  const queue: ClusterTask[] = [root];
  for (let task = queue.shift(); task; task = queue.shift()) {
    members.push(task);
    for (const child of childrenOf.get(task.id) ?? []) {
      if (seen.has(child.id)) {
        continue;
      }
      seen.add(child.id);
      edges.push({ id: `${task.id}->${child.id}`, source: task.id, target: child.id, kind: 'child' });
      queue.push(child);
    }
  }

  for (const child of children) {
    for (const dependency of child.dependsOn) {
      if (seen.has(child.id) && seen.has(dependency) && dependency !== child.id) {
        edges.push({ id: `dep:${dependency}->${child.id}`, source: dependency, target: child.id, kind: 'dependency' });
      }
    }
  }

  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'LR', nodesep: 12, ranksep: 40 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const { id } of members) {
    graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target, {}, edge.id);
  }
  dagre.layout(graph);

  const place = (id: string): Placed => {
    const placed = graph.node(id);
    return {
      id,
      x: placed.x - NODE_WIDTH / 2,
      y: placed.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  };
  return {
    nodes: members.map((task): TaskGraphNode => ({ ...place(task.id), kind: 'task', task, stage: stageOf(task) })),
    edges,
  };
}
