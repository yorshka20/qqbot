import dagre from '@dagrejs/dagre';
import type { ClusterJob, ClusterTask } from '@qqbot/api-types';
import { isLive, type Stage } from './stage';

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 40;

const INTEGRATION_ID = 'branch:integration';
const BASE_ID = 'branch:base';

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

export interface TaskGraphBranchNode extends Placed {
  kind: 'branch';
  branch: string;
  caption: string;
  reached: boolean;
}

export type TaskGraphNode = TaskGraphTaskNode | TaskGraphBranchNode;

export interface TaskGraphEdge {
  id: string;
  source: string;
  target: string;
  /** Work on its way along this edge: it has not arrived. */
  pending: boolean;
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
}

/**
 * The life of a job, left to right: the root, its children, the integration branch they merge
 * into, and the base branch it lands on. `tasks` may hold unrelated runs; only the root and its
 * descendants enter the graph. A job with no integration branch has only its tasks.
 */
export function buildTaskGraph(
  rootId: string,
  tasks: ClusterTask[],
  stageOf: (task: ClusterTask) => Stage,
  job: ClusterJob | undefined,
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
      edges.push({ id: `${task.id}->${child.id}`, source: task.id, target: child.id, pending: false });
      queue.push(child);
    }
  }

  const branches = branchNodes(job);
  if (job?.integrationBranch) {
    const delivering = members.length === 1 ? members : members.filter((task) => task.id !== rootId);
    for (const task of delivering) {
      if (task.mergedAt || isLive(task)) {
        const pending = !task.mergedAt;
        edges.push({ id: `${task.id}->${INTEGRATION_ID}`, source: task.id, target: INTEGRATION_ID, pending });
      }
    }
    if (job.baseBranch) {
      const pending = !job.landedAt;
      edges.push({ id: `${INTEGRATION_ID}->${BASE_ID}`, source: INTEGRATION_ID, target: BASE_ID, pending });
    }
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 12, ranksep: 40 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of [...members.map((task) => task.id), ...branches.map((branch) => branch.id)]) {
    graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
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
    nodes: [
      ...members.map((task): TaskGraphNode => ({ ...place(task.id), kind: 'task', task, stage: stageOf(task) })),
      ...branches.map((branch): TaskGraphNode => ({ ...place(branch.id), kind: 'branch', ...branch.data })),
    ],
    edges,
  };
}

function branchNodes(job: ClusterJob | undefined) {
  if (!job?.integrationBranch) {
    return [];
  }
  const landing = job.landError ? '合入失败' : '待合入';
  const integration = { branch: job.integrationBranch, caption: '集成分支', reached: true };
  const base = job.baseBranch
    ? [
        {
          id: BASE_ID,
          data: { branch: job.baseBranch, caption: job.landedAt ? '已合入' : landing, reached: Boolean(job.landedAt) },
        },
      ]
    : [];
  return [{ id: INTEGRATION_ID, data: integration }, ...base];
}
