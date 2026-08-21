import { ChevronDown, ChevronUp, Clock, FileText, GitBranch, Hash, Skull, Tag, Timer } from 'lucide-react';
import { marked } from 'marked';
import { useLayoutEffect, useRef, useState } from 'react';

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
  const canKill = w.status !== 'exited';
  const spawnedMs = w.spawnedAt ?? w.stats?.registeredAt;
  const taskId = w.resolvedTaskId ?? w.currentTaskId ?? w.lastBoundTaskId;
  const durationMs = spawnedMs != null ? (w.exitedAt ?? now) - spawnedMs : null;
  const hasReport = !!(w.lastReportSummary || w.lastReportNextSteps || w.lastHubReportAt);
  const taskSummary = w.boundTaskSummary ? stripFrontmatter(w.boundTaskSummary) : '';

  // The report summary expands in place instead of scrolling inside the card:
  // a nested scrollbox here trapped wheel events while scrolling the workers
  // list. Overflow is only re-measured while collapsed — expanded content
  // never overflows, and measuring then would drop the collapse button.
  const [reportExpanded, setReportExpanded] = useState(false);
  const [reportOverflows, setReportOverflows] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on summary content, measured via ref inside the effect
  useLayoutEffect(() => {
    if (reportExpanded) {
      return;
    }
    const el = reportRef.current;
    if (el) {
      setReportOverflows(el.scrollHeight > el.clientHeight + 1);
    }
  }, [reportExpanded, w.lastReportSummary]);

  return (
    <div className="w-full min-w-0 shrink-0 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
      {/* ── Row 1: Header — full width ── */}
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap bg-zinc-50/80 dark:bg-zinc-700/30">
        <span className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-100">{w.workerId}</span>
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
        {canKill && (
          <button
            type="button"
            onClick={() => onRequestKill(w.workerId)}
            className="p-1 rounded text-red-500/70 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            aria-label={`Kill worker ${w.workerId}`}
            title={isRunning ? 'Kill worker' : 'Mark worker exited (orphan cleanup)'}
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
            <span className="uppercase tracking-wider font-semibold text-zinc-400 dark:text-zinc-500">HUB_REPORT</span>
            {w.lastReportStatus && <ClusterStatusBadge status={w.lastReportStatus} />}
            <span className="text-zinc-400 dark:text-zinc-500 tabular-nums">
              {w.lastHubReportAt != null ? `${formatMs(now - w.lastHubReportAt)} ago` : ''}
            </span>
            {w.stats?.totalReports != null && (
              <span className="text-zinc-400 dark:text-zinc-500">· {w.stats.totalReports} reports</span>
            )}
          </div>

          {/* Summary — full-width markdown, collapsed to a preview by default */}
          {w.lastReportSummary && (
            <div>
              <div
                ref={reportRef}
                className={`w-full text-xs text-zinc-700 dark:text-zinc-200 leading-relaxed bg-zinc-50 dark:bg-zinc-900/40 rounded-md px-4 py-3 border border-zinc-100 dark:border-zinc-700/50 prose prose-xs dark:prose-invert max-w-none prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border-collapse prose-th:border prose-td:border prose-th:border-zinc-300 prose-td:border-zinc-200 dark:prose-th:border-zinc-600 dark:prose-td:border-zinc-700 prose-th:bg-zinc-100 dark:prose-th:bg-zinc-800 ${
                  reportExpanded ? '' : 'max-h-44 overflow-hidden'
                }`}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted hub_report from our own workers
                dangerouslySetInnerHTML={renderMarkdown(w.lastReportSummary) ?? undefined}
              />
              {(reportOverflows || reportExpanded) && (
                <button
                  type="button"
                  onClick={() => setReportExpanded((e) => !e)}
                  className="mt-1 flex items-center gap-0.5 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {reportExpanded ? (
                    <>
                      <ChevronUp className="w-3 h-3" />
                      Collapse report
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-3 h-3" />
                      Show full report
                    </>
                  )}
                </button>
              )}
            </div>
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
