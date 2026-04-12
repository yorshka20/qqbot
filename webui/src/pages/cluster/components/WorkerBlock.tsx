import { FileText, Skull } from 'lucide-react';

import type { ClusterWorkerRegistration } from '../../../types';
import { useNow } from '../hooks/useNow';
import { formatEpoch, formatMs } from '../utils';

export function WorkerBlock({
  w,
  onOpenTaskOutput,
  onRequestKill,
}: {
  w: ClusterWorkerRegistration;
  onOpenTaskOutput: (taskId: string) => void;
  onRequestKill: (workerId: string) => void;
}) {
  const now = useNow();
  const isRunning = w.status === 'running' || w.status === 'active';
  const spawnedMs = w.spawnedAt ?? w.stats?.registeredAt;
  const taskId = w.resolvedTaskId ?? w.currentTaskId ?? w.lastBoundTaskId;

  return (
    <div className="w-full min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2 box-border">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{w.workerId}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {w.project ?? '-'} · {w.templateName ?? '-'} · {w.role ?? '-'} · {w.status ?? '-'}
        </div>
        <div className="flex-1" />
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          lastSeen: {w.lastSeen ? formatMs(now - w.lastSeen) : '-'}
        </div>
        {taskId && (
          <button
            type="button"
            onClick={() => onOpenTaskOutput(taskId)}
            className="px-2 py-1 rounded text-xs font-medium border border-zinc-200 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-1 shrink-0"
            title="Open task modal — Output is worker CLI stdout"
          >
            <FileText className="w-3.5 h-3.5" />
            Task output
          </button>
        )}
        {isRunning && (
          <button
            type="button"
            onClick={() => onRequestKill(w.workerId)}
            className="p-1 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
            aria-label={`Kill worker ${w.workerId}`}
            title="Kill worker"
          >
            <Skull className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="mt-2 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-300">
        {spawnedMs != null && (
          <div>
            <span className="text-zinc-500 dark:text-zinc-400">spawned: </span>
            {formatEpoch(spawnedMs)}
            <span className="text-zinc-500 dark:text-zinc-400"> ({formatMs(now - spawnedMs)} ago)</span>
          </div>
        )}
        {w.exitedAt != null && (
          <div>
            <span className="text-zinc-500 dark:text-zinc-400">exited: </span>
            {formatEpoch(w.exitedAt)}
            <span className="text-zinc-500 dark:text-zinc-400"> ({formatMs(now - w.exitedAt)} ago)</span>
          </div>
        )}
        <div>
          <span className="text-zinc-500 dark:text-zinc-400">task: </span>
          <span className="font-mono">{taskId ?? '—'}</span>
        </div>
        <div>
          <span className="text-zinc-500 dark:text-zinc-400">job: </span>
          <span className="font-mono">{w.boundJobId ?? '—'}</span>
        </div>
        <div>
          <span className="text-zinc-500 dark:text-zinc-400">ticket: </span>
          <span className="font-mono">{w.boundTicketId ?? '—'}</span>
        </div>
        {w.boundTaskSummary ? (
          <div className="text-zinc-500 dark:text-zinc-400 pt-1 line-clamp-3 whitespace-pre-wrap break-words">
            {w.boundTaskSummary}
          </div>
        ) : null}
      </div>
      {(w.lastReportSummary || w.lastReportNextSteps || w.lastHubReportAt) && (
        <div className="mt-2 space-y-1 text-xs border-t border-zinc-100 dark:border-zinc-700/80 pt-2">
          {w.lastHubReportAt != null && (
            <div className="text-zinc-500 dark:text-zinc-400">
              last hub_report: {formatMs(now - w.lastHubReportAt)} ago
              {w.lastReportStatus ? ` · ${w.lastReportStatus}` : ''}
            </div>
          )}
          {w.lastReportSummary ? (
            <div className="text-zinc-700 dark:text-zinc-200">
              <span className="text-zinc-500 dark:text-zinc-400">summary: </span>
              {w.lastReportSummary}
            </div>
          ) : null}
          {w.lastReportNextSteps ? (
            <div className="text-zinc-700 dark:text-zinc-200">
              <span className="text-zinc-500 dark:text-zinc-400">next: </span>
              {w.lastReportNextSteps}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
