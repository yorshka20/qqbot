import { Clock, FileText, GitBranch, Hash, Skull, Tag, Timer } from 'lucide-react';
import { marked } from 'marked';

import type { ClusterWorkerRegistration } from '../../../types';
import { useNow } from '../hooks/useNow';
import { formatEpoch, formatMs } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';

/** Render hub_report summary markdown to HTML. */
function renderMarkdown(text: string): { __html: string } | null {
  if (!text) return null;
  const html = marked.parse(text, { breaks: true, gfm: true });
  return { __html: typeof html === 'string' ? html : '' };
}

/** Strip frontmatter (---\n...\n---) from task description for display. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---[\s\S]*?---\s*/, '').trim();
}

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
  const durationMs = spawnedMs != null ? (w.exitedAt ?? now) - spawnedMs : null;
  const hasReport = !!(w.lastReportSummary || w.lastReportNextSteps || w.lastHubReportAt);
  const taskSummary = w.boundTaskSummary ? stripFrontmatter(w.boundTaskSummary) : '';

  return (
    <div className="w-full min-w-0 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30">
      {/* ── Row 1: Header — full width ── */}
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap bg-zinc-50/80 dark:bg-zinc-800/40">
        <span className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-100">
          {w.workerId}
        </span>
        {w.role && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              w.role === 'planner'
                ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300'
                : 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300'
            }`}
          >
            {w.role}
          </span>
        )}
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {w.templateName ?? '-'} · {w.project || '-'}
        </span>
        <ClusterStatusBadge status={w.status ?? 'unknown'} />
        <div className="flex-1" />
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
          {w.lastSeen ? `${formatMs(now - w.lastSeen)} ago` : '-'}
        </span>
        {taskId && (
          <button
            type="button"
            onClick={() => onOpenTaskOutput(taskId)}
            className="px-2 py-1 rounded text-[11px] font-medium border border-zinc-200 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-1 shrink-0 transition-colors"
            title="Open task output modal"
          >
            <FileText className="w-3 h-3" />
            Output
          </button>
        )}
        {isRunning && (
          <button
            type="button"
            onClick={() => onRequestKill(w.workerId)}
            className="p-1 rounded text-red-500/70 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            aria-label={`Kill worker ${w.workerId}`}
            title="Kill worker"
          >
            <Skull className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Row 2: Info grid — metadata left, task summary right ── */}
      <div className="px-3 py-2 grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 items-start border-b border-zinc-100 dark:border-zinc-700/40">
        {/* Left: metadata pills */}
        <div className="flex items-center gap-3 text-[11px] flex-wrap">
          {spawnedMs != null && (
            <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
              <Clock className="w-3 h-3 shrink-0" />
              {formatEpoch(spawnedMs)}
            </span>
          )}
          {durationMs != null && (
            <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
              <Timer className="w-3 h-3 shrink-0" />
              <span className="text-zinc-700 dark:text-zinc-200 tabular-nums">{formatMs(durationMs)}</span>
              {w.exitedAt != null && <span>(exited)</span>}
            </span>
          )}
          {taskId && (
            <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
              <Hash className="w-3 h-3 shrink-0" />
              <span className="font-mono text-zinc-600 dark:text-zinc-300">{taskId.slice(0, 8)}</span>
            </span>
          )}
          {w.boundJobId && (
            <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
              <GitBranch className="w-3 h-3 shrink-0" />
              <span className="font-mono text-zinc-600 dark:text-zinc-300">{w.boundJobId.slice(0, 8)}</span>
            </span>
          )}
          {w.boundTicketId && (
            <span className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
              <Tag className="w-3 h-3 shrink-0" />
              <span className="font-mono text-zinc-600 dark:text-zinc-300">{w.boundTicketId}</span>
            </span>
          )}
        </div>

        {/* Right: task summary (only on lg+ where grid has 2 cols) */}
        {taskSummary ? (
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2 whitespace-pre-wrap break-words leading-relaxed min-w-0">
            {taskSummary}
          </div>
        ) : null}
      </div>

      {/* ── Row 3: Hub report — full width ── */}
      {hasReport && (
        <div className="px-3 py-2.5 space-y-2">
          {/* Report status bar */}
          <div className="flex items-center gap-2 text-[10px]">
            <span className="uppercase tracking-wider font-semibold text-zinc-400 dark:text-zinc-500">
              HUB_REPORT
            </span>
            {w.lastReportStatus && <ClusterStatusBadge status={w.lastReportStatus} />}
            <span className="text-zinc-400 dark:text-zinc-500 tabular-nums">
              {w.lastHubReportAt != null ? `${formatMs(now - w.lastHubReportAt)} ago` : ''}
            </span>
            {w.stats?.totalReports != null && (
              <span className="text-zinc-400 dark:text-zinc-500">
                · {w.stats.totalReports} reports
              </span>
            )}
          </div>

          {/* Summary — full-width markdown */}
          {w.lastReportSummary && (
            <div
              className="w-full text-xs text-zinc-700 dark:text-zinc-200 leading-relaxed bg-zinc-50 dark:bg-zinc-800/40 rounded-md px-4 py-3 border border-zinc-100 dark:border-zinc-700/50 max-h-[280px] overflow-y-auto prose prose-xs dark:prose-invert max-w-none prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border-collapse prose-th:border prose-td:border prose-th:border-zinc-300 prose-td:border-zinc-200 dark:prose-th:border-zinc-600 dark:prose-td:border-zinc-700 prose-th:bg-zinc-100 dark:prose-th:bg-zinc-800"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted hub_report from our own workers
              dangerouslySetInnerHTML={renderMarkdown(w.lastReportSummary) ?? undefined}
            />
          )}

          {/* Next steps */}
          {w.lastReportNextSteps && (
            <div className="w-full text-xs text-zinc-600 dark:text-zinc-300 bg-blue-50/50 dark:bg-blue-950/20 rounded-md px-3 py-2 border border-blue-100/80 dark:border-blue-900/30 whitespace-pre-wrap break-words">
              <span className="text-[10px] uppercase tracking-wider font-medium text-blue-500/70 dark:text-blue-400/70 mr-1.5">
                next →
              </span>
              {w.lastReportNextSteps}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
