import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { GitBranch } from 'lucide-react';
import { cn } from '../lib/utils';

export interface BranchNodeData extends Record<string, unknown> {
  branch: string;
  caption: string;
  reached: boolean;
}

export type BranchFlowNode = Node<BranchNodeData, 'branch'>;

export function BranchNode({ data }: NodeProps<BranchFlowNode>) {
  const { branch, caption, reached } = data;
  return (
    <div
      className={cn(
        'flex h-full w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted px-2.5 text-xs text-card-foreground',
        reached && 'border-solid',
      )}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <GitBranch className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
      <span className="shrink-0 text-muted-foreground">{caption}</span>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}
