import { Background, Controls, type Edge, type Node, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getClusterTaskEvents, getClusterTaskOutput } from '../api';
import { useResolvedTheme } from '../app/theme';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { useOutput } from '../lib/outputs';
import { layoutRunFlow, type RunFlowNode } from '../lib/runFlow';
import { buildRunTrace, type RunTrace, type TraceStep } from '../lib/runTrace';
import { parseTranscript, type TranscriptEntry } from '../lib/transcript';
import { TranscriptRow } from '../task/TranscriptRow';
import { FileNode, MoreNode, PhaseNode, ReadOnlyNode, SegmentNode } from './RunFlowNodes';
import { StepNode } from './StepNode';

const REFETCH_DEBOUNCE_MS = 2000;

const nodeTypes = {
  segment: SegmentNode,
  phase: PhaseNode,
  step: StepNode,
  more: MoreNode,
  file: FileNode,
  readonly: ReadOnlyNode,
};

interface Loaded {
  entries: TranscriptEntry[];
  trace: RunTrace;
}

function toFlowNode(node: RunFlowNode, selectedStepId: string | null): Node {
  const base = {
    id: node.id,
    type: node.type,
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    draggable: false,
    ...(node.parentId ? { parentId: node.parentId, extent: 'parent' as const } : {}),
  };
  switch (node.type) {
    case 'segment':
    case 'phase':
      return { ...base, data: { label: node.label }, selectable: false };
    case 'step':
      return { ...base, data: { step: node.step, selected: node.step.id === selectedStepId } };
    case 'more':
      return { ...base, data: { hidden: node.hidden }, selectable: false };
    case 'file':
      return { ...base, data: { path: node.path, edits: node.edits }, selectable: false };
    case 'readonly':
      return { ...base, data: { paths: node.paths, total: node.total }, selectable: false };
  }
}

function useRunTrace(taskId: string): { loaded: Loaded | null; failed: boolean } {
  const output = useOutput(taskId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  const load = useRef(() => {});
  load.current = () => {
    const mine = ++generation.current;
    Promise.all([getClusterTaskOutput(taskId, { full: true }), getClusterTaskEvents(taskId)])
      .then(([{ output: full, truncated }, events]) => {
        if (mine !== generation.current) {
          return;
        }
        const resumes = events
          .filter((event) => event.type === 'task_resumed')
          .sort((a, b) => a.timestamp - b.timestamp)
          .map((event) => ({
            at: event.timestamp,
            reason: typeof event.data.reason === 'string' ? event.data.reason : undefined,
          }));
        const entries = parseTranscript(full) ?? [];
        setLoaded({ entries, trace: buildRunTrace(entries, { truncated, resumes }) });
        setFailed(false);
      })
      .catch(() => {
        if (mine === generation.current) {
          setFailed(true);
        }
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` is a stable ref and `output` is the trigger
  useEffect(() => {
    const timer = setTimeout(() => load.current(), loaded === null ? 0 : REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [taskId, output]);

  return { loaded, failed };
}

export function RunFlow({ taskId, backTo }: { taskId: string; backTo: string }) {
  const colorMode = useResolvedTheme();
  const { loaded, failed } = useRunTrace(taskId);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const layout = useMemo(() => (loaded ? layoutRunFlow(loaded.trace) : null), [loaded]);
  const steps = useMemo(() => {
    const byId = new Map<string, TraceStep>();
    for (const segment of loaded?.trace.segments ?? []) {
      for (const phase of segment.phases) {
        for (const step of phase.steps) {
          byId.set(step.id, step);
        }
      }
    }
    return byId;
  }, [loaded]);
  const entryById = useMemo(() => new Map((loaded?.entries ?? []).map((entry) => [entry.id, entry])), [loaded]);

  const nodes = useMemo(
    () => (layout ? layout.nodes.map((node) => toFlowNode(node, selectedStepId)) : []),
    [layout, selectedStepId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      layout
        ? layout.edges.map(({ id, source, target, kind }) => ({
            id,
            source,
            target,
            style: kind === 'edit' ? { strokeDasharray: '4 4' } : undefined,
          }))
        : [],
    [layout],
  );

  const selected = selectedStepId ? steps.get(selectedStepId) : undefined;
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });

  let body: React.ReactNode;
  if (!loaded) {
    body = <p className="p-6 text-sm text-muted-foreground">{failed ? '读取运行日志失败。' : '正在读取日志…'}</p>;
  } else if (nodes.every((node) => node.type !== 'step')) {
    body = <p className="p-6 text-sm text-muted-foreground">这条运行还没有可画的步骤。</p>;
  } else {
    body = (
      <ReactFlow
        key={taskId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        nodesDraggable={false}
        nodesConnectable={false}
        onlyRenderVisibleElements
        onNodeClick={(_, node) => {
          if (node.type === 'step') {
            const step = (node.data as { step: TraceStep }).step;
            setSelectedStepId(step.id);
          }
        }}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 text-sm md:px-6">
        <Link to={backTo} className="text-muted-foreground hover:text-foreground hover:underline">
          ← 任务树
        </Link>
        {loaded?.trace.truncated && <span className="text-xs text-muted-foreground">日志过长，只画出最后 8 MiB</span>}
      </div>
      <div className="min-h-0 flex-1">{body}</div>
      <Sheet open={selected !== undefined} onOpenChange={(open) => !open && setSelectedStepId(null)}>
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="break-words">{selected?.title}</SheetTitle>
            <SheetDescription>
              {selected ? `${selected.entryIds.length} 条记录${selected.failed ? ' · 有失败' : ''}` : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="mx-4 mb-4 min-h-0 flex-1 overflow-y-auto rounded-md bg-log-bg py-2 text-log-ink">
            {selected?.entryIds.map((entryId) => {
              const entry = entryById.get(entryId);
              return entry ? (
                <TranscriptRow
                  key={entry.id}
                  entry={entry}
                  expanded={expanded.has(entry.id)}
                  onToggle={() => toggle(entry.id)}
                  now={Date.now()}
                  showClock={false}
                />
              ) : null;
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
