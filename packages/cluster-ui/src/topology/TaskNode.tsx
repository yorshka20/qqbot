import type { ClusterTask } from '@qqbot/api-types';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { Check } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useCluster } from '../app/ClusterData';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { modelDisplayName, runModelName } from '../lib/model';
import { runViewPath, workerPath } from '../lib/routes';
import { runTimes, runTitle } from '../lib/runs';
import { isLive, STAGE_LABEL, STAGE_TONE, type Stage } from '../lib/stage';
import { formatClock, formatSpan } from '../lib/time';
import { usageFacts } from '../lib/usage';
import { useNow } from '../lib/useNow';
import { cn } from '../lib/utils';

export interface TaskNodeData extends Record<string, unknown> {
  task: ClusterTask;
  stage: Stage;
  rootId: string;
  isRoot: boolean;
  current: boolean;
}

export type TaskFlowNode = Node<TaskNodeData, 'task'>;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-10 shrink-0 opacity-70">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, stage, rootId, isRoot, current } = data;
  const navigate = useNavigate();
  const now = useNow();
  const { workerExits, workers, locks } = useCluster();
  const exitedAt = task.workerId ? workerExits.get(task.workerId) : undefined;
  const { startedAt, endedAt, durationMs } = runTimes(task, exitedAt, now);
  const title = runTitle(task.description);
  const ended = !isLive(task);
  const lastSaid = workers.find((worker) => worker.workerId === task.workerId)?.lastReportSummary;
  const lockCount = locks.filter(
    (lock) => lock.taskId === task.id || (task.workerId && lock.workerId === task.workerId),
  ).length;
  const usage = usageFacts(task.usage);
  const summary = ended ? task.diffSummary?.split('\n', 1)[0] || lastSaid : lastSaid;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          onClick={() => navigate(isRoot ? runViewPath(rootId) : workerPath(rootId, task.id, 'topology'))}
          className={cn(
            'flex h-full w-full flex-col items-stretch justify-center gap-0.5 rounded-md border border-border bg-card px-2.5 text-left font-normal text-xs text-card-foreground hover:bg-muted hover:text-card-foreground dark:hover:bg-muted',
            current && 'ring-2 ring-ring',
            ended && 'opacity-60',
          )}
        >
          <Handle type="target" position={Position.Left} className="opacity-0" />
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot tone={STAGE_TONE[stage]} breathing={stage === 'running'} />
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            {task.mergedAt && <Check className="size-3.5 shrink-0 text-done" aria-label="已合入" />}
            {task.resumeCount ? (
              <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">续 ×{task.resumeCount}</span>
            ) : null}
            <span className="shrink-0 text-muted-foreground">{runModelName(task)}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {durationMs !== null ? formatSpan(durationMs) : '—'}
            </span>
          </span>
          <span className="block min-w-0 truncate pl-4 text-muted-foreground">{summary ?? ''}</span>
          <Handle type="source" position={Position.Right} className="opacity-0" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-stretch gap-0.5">
        <Detail label="任务">{runTitle(task.description)}</Detail>
        <Detail label="模型">{task.model ? modelDisplayName(task.model) : runModelName(task)}</Detail>
        <Detail label="状态">{STAGE_LABEL[stage]}</Detail>
        <Detail label="开始">{startedAt !== null ? formatClock(startedAt, now) : '尚未开始'}</Detail>
        <Detail label="用时">{durationMs !== null ? formatSpan(durationMs) : '—'}</Detail>
        {endedAt !== null && <Detail label="结束">{formatClock(endedAt, now)}</Detail>}
        <Detail label="token">
          输入 {usage.input} · 输出 {usage.output}
        </Detail>
        {lastSaid && <Detail label="最近">{lastSaid}</Detail>}
        <Detail label="文件锁">{lockCount}</Detail>
      </TooltipContent>
    </Tooltip>
  );
}
