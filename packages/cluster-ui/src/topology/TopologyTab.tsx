import type { ClusterTask, ClusterTaskChild } from '@qqbot/api-types';
import { Background, Controls, type Edge, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { useCluster } from '../app/ClusterData';
import { useResolvedTheme } from '../app/theme';
import { stageOfStatus } from '../lib/stage';
import { buildTaskGraph } from '../lib/taskGraph';
import { type TaskFlowNode, TaskNode } from './TaskNode';

const nodeTypes = { task: TaskNode };

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
  detail: ClusterTask & { children?: ClusterTaskChild[] };
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
  const graph = useMemo(
    () =>
      buildTaskGraph(
        rootId,
        tasks,
        (task) => stageByTaskId.get(task.id) ?? stageOfStatus(task.status),
        detail.children ?? [],
      ),
    [rootId, tasks, stageByTaskId, detail.children],
  );

  const nodes = useMemo<TaskFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'task' as const,
        position: { x: node.x, y: node.y },
        width: node.width,
        height: node.height,
        data: {
          task: node.task,
          stage: node.stage,
          rootId,
          isRoot: node.id === rootId,
          current: node.id === currentId,
        },
      })),
    [graph, rootId, currentId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map(({ id, source, target, kind }) =>
        kind === 'dependency'
          ? {
              id,
              source,
              target,
              label: '依赖',
              style: { strokeDasharray: '4 4' },
              labelStyle: { fontSize: 11 },
            }
          : { id, source, target },
      ),
    [graph],
  );

  if (graph.nodes.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">这条运行还没有可画的节点。</p>;
  }

  return (
    <div className="h-full w-full">
      {/* `fitView` runs once per mount, and children arrive after the root does. */}
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
