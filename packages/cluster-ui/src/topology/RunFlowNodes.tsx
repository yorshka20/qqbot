import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { Files, FileText } from 'lucide-react';
import { memo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';

export type GroupFlowNode = Node<{ label: string }, 'segment' | 'phase'>;
export type MoreFlowNode = Node<{ hidden: number }, 'more'>;
export type FileFlowNode = Node<{ path: string; edits: number }, 'file'>;
export type ReadOnlyFlowNode = Node<{ paths: string[]; total: number }, 'readonly'>;

export const SegmentNode = memo(function SegmentNode({ data }: NodeProps<GroupFlowNode>) {
  return (
    <div className="h-full w-full rounded-lg border border-border bg-surface/40">
      <p className="px-3 pt-2 text-sm font-medium text-foreground">{data.label}</p>
    </div>
  );
});

export const PhaseNode = memo(function PhaseNode({ data }: NodeProps<GroupFlowNode>) {
  return (
    <div className="h-full w-full rounded-md border border-dashed border-border bg-surface-2/40">
      <p className="truncate px-2.5 pt-1.5 text-xs text-muted-foreground">{data.label}</p>
    </div>
  );
});

export const MoreNode = memo(function MoreNode({ data }: NodeProps<MoreFlowNode>) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
      <Handle type="target" position={Position.Top} className="opacity-0" />
      还有 {data.hidden} 步
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
});

export const FileNode = memo(function FileNode({ data }: NodeProps<FileFlowNode>) {
  return (
    <div
      title={data.path}
      className={cn('flex h-full w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs')}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <FileText className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono">{data.path}</span>
      <span className="shrink-0 text-muted-foreground">改 {data.edits} 次</span>
    </div>
  );
});

export const ReadOnlyNode = memo(function ReadOnlyNode({ data }: NodeProps<ReadOnlyFlowNode>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-full w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted px-2.5 text-xs text-muted-foreground">
          <Files className="size-3.5 shrink-0" />
          只读 {data.total} 个文件
        </div>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-stretch gap-0.5 font-mono">
        {data.paths.map((path) => (
          <span key={path}>{path}</span>
        ))}
        {data.total > data.paths.length && <span>…另外 {data.total - data.paths.length} 个</span>}
      </TooltipContent>
    </Tooltip>
  );
});
