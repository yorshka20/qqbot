import dagre from '@dagrejs/dagre';
import type { ClusterTask } from '@qqbot/api-types';
import type { Stage } from './stage';

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 36;

export interface TaskGraphNode {
  id: string;
  task: ClusterTask;
  stage: Stage;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TaskGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
}

/** `tasks` may hold unrelated runs; only the root and its descendants enter the graph. */
export function buildTaskGraph(rootId: string, tasks: ClusterTask[], stageOf: (task: ClusterTask) => Stage): TaskGraph {
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
      edges.push({ id: `${task.id}->${child.id}`, source: task.id, target: child.id });
      queue.push(child);
    }
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 12, ranksep: 48 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const task of members) {
    graph.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);

  const nodes = members.map((task) => {
    const placed = graph.node(task.id);
    return {
      id: task.id,
      task,
      stage: stageOf(task),
      x: placed.x - NODE_WIDTH / 2,
      y: placed.y - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
  return { nodes, edges };
}
