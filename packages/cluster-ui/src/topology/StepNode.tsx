import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { FilePen, FlaskConical, GitFork, type LucideIcon, MessageSquare, Radio, Search, Terminal } from 'lucide-react';
import { memo } from 'react';
import type { TraceStep, TraceStepKind } from '../lib/runTrace';
import { cn } from '../lib/utils';

export type StepFlowNode = Node<{ step: TraceStep; selected: boolean }, 'step'>;

const STEP_ICON: Record<TraceStepKind, LucideIcon> = {
  explore: Search,
  edit: FilePen,
  command: Terminal,
  test: FlaskConical,
  hub: Radio,
  delegate: GitFork,
  message: MessageSquare,
};

export const StepNode = memo(function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step, selected } = data;
  const Icon = STEP_ICON[step.kind];
  return (
    <div
      title={step.title}
      className={cn(
        'flex h-full w-full cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs text-card-foreground hover:bg-muted',
        step.failed && 'border-failed text-failed',
        selected && 'ring-2 ring-ring',
      )}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{step.title}</span>
      {step.count > 1 && <span className="shrink-0 tabular-nums text-muted-foreground">×{step.count}</span>}
      {step.kind === 'test' && (
        <span className={cn('shrink-0 font-medium', step.failed ? 'text-failed' : 'text-done')}>
          {step.failed ? '失败' : '通过'}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
});
