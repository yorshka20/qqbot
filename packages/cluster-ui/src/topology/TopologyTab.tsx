import type { ClusterTask } from '@qqbot/api-types';
import { Background, Controls, type Edge, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { useCluster } from '../app/ClusterData';
import { useResolvedTheme } from '../app/theme';
import { stageOfStatus } from '../lib/stage';
import { buildTaskGraph } from '../lib/taskGraph';
import { type BranchFlowNode, BranchNode } from './BranchNode';
import { type TaskFlowNode, TaskNode } from './TaskNode';

const nodeTypes = { task: TaskNode, branch: BranchNode };

/** Tasks the graph may draw from: the loaded runs, the open task and its children, deduplicated by id. */
function mergeTasks(runTasks: ClusterTask[], detail: ClusterTask, children: ClusterTask[]): ClusterTask[] {
  const byId = new Map<string, ClusterTask>();
  for (const task of [...runTasks, detail, ...children]) {
    byId.set(task.id, task);
  }
  return [...byId.values()];
}

export function TopologyTab({
  rootId,
  currentId,
  detail,
}: {
  rootId: string;
  currentId: string;
  detail: ClusterTask & { children?: ClusterTask[] };
}) {
  const { runs } = useCluster();
  const colorMode = useResolvedTheme();

  const stageByTaskId = useMemo(() => new Map(runs.map((run) => [run.task.id, run.stage])), [runs]);
  const tasks = useMemo(
    () =>
      mergeTasks(
        runs.map((run) => run.task),
        detail,
        detail.children ?? [],
      ),
    [runs, detail],
  );
  const job = runs.find((run) => run.task.id === rootId)?.job;
  const graph = useMemo(
    () => buildTaskGraph(rootId, tasks, (task) => stageByTaskId.get(task.id) ?? stageOfStatus(task.status), job),
    [rootId, tasks, stageByTaskId, job],
  );

  const nodes = useMemo<Array<TaskFlowNode | BranchFlowNode>>(
    () =>
      graph.nodes.map((node) => {
        const placed = { id: node.id, position: { x: node.x, y: node.y }, width: node.width, height: node.height };
        return node.kind === 'branch'
          ? {
              ...placed,
              type: 'branch' as const,
              data: { branch: node.branch, caption: node.caption, reached: node.reached },
            }
          : {
              ...placed,
              type: 'task' as const,
              data: {
                task: node.task,
                stage: node.stage,
                rootId,
                isRoot: node.id === rootId,
                current: node.id === currentId,
              },
            };
      }),
    [graph, rootId, currentId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map(({ id, source, target, pending }) => ({
        id,
        source,
        target,
        style: pending ? { strokeDasharray: '4 4' } : undefined,
      })),
    [graph],
  );

  if (graph.nodes.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">这条运行还没有可画的节点。</p>;
  }

  return (
    <div className="h-full w-full">
      {/* `fitView` runs once per mount, and the branch nodes arrive after the tasks do. */}
      <ReactFlow
        key={graph.nodes.length}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
