import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileCode,
  Loader2,
  Pause,
  X,
} from 'lucide-react';
import { marked } from 'marked';
import { useCallback, useEffect, useState } from 'react';

import { getClusterTaskEvents } from '../../../api';
import type { ClusterEventEntry, ClusterTask } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';

/** Safely parse hub_report summary markdown to HTML. */
function renderMarkdown(text: string): { __html: string } {
  const html = marked.parse(text, { breaks: true, gfm: true });
  return { __html: typeof html === 'string' ? html : '' };
}

/** Extract report-type events (worker_progress, task_completed, task_failed, task_blocked). */
function isReportEvent(ev: ClusterEventEntry): boolean {
  return ['worker_progress', 'task_completed', 'task_failed', 'task_blocked'].includes(ev.type);
}

/** Status icon for report timeline entries. */
function ReportStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    case 'failed':
      return <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />;
    case 'blocked':
      return <Pause className="w-3.5 h-3.5 text-purple-500 shrink-0" />;
    default:
      return <Clock className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
  }
}

export function TaskOutputModal({
  task,
  onClose,
}: {
  task: ClusterTask;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<ClusterEventEntry[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  // Fetch task events for the report timeline
  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const evts = await getClusterTaskEvents(task.id);
      setEvents(evts);
    } catch {
      // Non-critical — timeline just won't show
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const reportEvents = events?.filter(isReportEvent) ?? [];
  const lastReport = reportEvents.length > 0 ? reportEvents[reportEvents.length - 1] : null;
  // Prefer persisted diffSummary (set from terminal hub_report), fall back to event log
  const lastSummary = task.diffSummary || (lastReport?.data?.summary as string | undefined);
  const filesModified = task.filesModified
    ? (typeof task.filesModified === 'string'
        ? (() => {
            try {
              return JSON.parse(task.filesModified) as string[];
            } catch {
              return [task.filesModified];
            }
          })()
        : [])
    : (lastReport?.data?.filesModified as string[] | undefined);

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(90vw,80rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-white dark:bg-zinc-800 shadow-2xl flex flex-col focus:outline-none">
          {/* ── Header ── */}
          <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
            <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Task {task.id.slice(0, 8)}
            </Dialog.Title>
            <ClusterStatusBadge status={task.status} />
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate min-w-0">
              {task.workerTemplate ?? '-'} · worker {task.workerId?.slice(0, 12) ?? '-'}
            </div>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* ── Body ── */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {/* Timestamps */}
            <div className="grid grid-cols-3 gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">Created</div>
                {formatTimestamp(task.createdAt)}
              </div>
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">Started</div>
                {formatTimestamp(task.startedAt)}
              </div>
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">Completed</div>
                {formatTimestamp(task.completedAt)}
              </div>
            </div>

            {/* ── Final summary from hub_report (rendered as markdown) ── */}
            {lastSummary && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1 font-medium">
                  Report Summary
                </div>
                <div
                  className="text-sm text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700 max-h-[300px] overflow-y-auto prose prose-sm dark:prose-invert prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border-collapse prose-th:border prose-td:border prose-th:border-zinc-200 prose-td:border-zinc-200 dark:prose-th:border-zinc-700 dark:prose-td:border-zinc-700 prose-th:bg-zinc-100 dark:prose-th:bg-zinc-800"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted hub_report from our own cluster workers
                  dangerouslySetInnerHTML={renderMarkdown(lastSummary)}
                />
              </div>
            )}

            {/* ── Files modified ── */}
            {filesModified && filesModified.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1 font-medium flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5" />
                  Files Modified ({filesModified.length})
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-2 border border-zinc-200 dark:border-zinc-700 max-h-[150px] overflow-y-auto">
                  {filesModified.map((f) => (
                    <div key={f} className="text-xs font-mono text-zinc-700 dark:text-zinc-300 py-0.5 px-1">
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Report Timeline ── */}
            {reportEvents.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2 font-medium">
                  Report Timeline ({reportEvents.length})
                </div>
                <div className="space-y-0 border-l-2 border-zinc-200 dark:border-zinc-700 ml-2 max-h-[300px] overflow-y-auto">
                  {reportEvents.map((ev) => {
                    const status = String(ev.data?.status ?? ev.type.replace('task_', ''));
                    const summary = String(ev.data?.summary ?? '').trim();
                    const nextSteps = ev.data?.nextSteps ? String(ev.data.nextSteps).trim() : '';
                    const evFiles = Array.isArray(ev.data?.filesModified)
                      ? (ev.data.filesModified as string[])
                      : undefined;
                    const detail = (ev.data?.detail ?? undefined) as
                      | { error?: unknown; blockReason?: unknown; linesAdded?: unknown; linesRemoved?: unknown; testsRan?: unknown; testsPassed?: unknown }
                      | undefined;
                    return (
                      <div
                        key={`${ev.seq}-${ev.timestamp}`}
                        className="relative pl-5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 rounded-r transition-colors"
                      >
                        {/* Timeline dot */}
                        <div className="absolute left-[-5px] top-3 bg-white dark:bg-zinc-800">
                          <ReportStatusIcon status={status} />
                        </div>

                        <div className="flex items-center gap-2 mb-0.5">
                          <ClusterStatusBadge status={status} />
                          <time className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
                            {new Date(ev.timestamp).toLocaleTimeString()}
                          </time>
                        </div>

                        {summary && (
                          <div className="text-xs text-zinc-700 dark:text-zinc-200 mt-1 whitespace-pre-wrap break-words line-clamp-3">
                            {summary}
                          </div>
                        )}
                        {nextSteps && (
                          <div className="text-[11px] text-blue-600 dark:text-blue-400 mt-0.5">
                            → {nextSteps}
                          </div>
                        )}
                        {evFiles != null && evFiles.length > 0 ? (
                          <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 font-mono">
                            files: {evFiles.join(', ')}
                          </div>
                        ) : null}
                        {detail?.error != null ? (
                          <div className="text-[11px] text-red-600 dark:text-red-400 mt-0.5">
                            error: {String(detail.error)}
                          </div>
                        ) : null}
                        {detail?.blockReason != null ? (
                          <div className="text-[11px] text-purple-600 dark:text-purple-400 mt-0.5">
                            blocked: {String(detail.blockReason)}
                          </div>
                        ) : null}
                        {(detail?.testsRan != null || detail?.linesAdded != null) && (
                          <div className="flex gap-3 text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                            {detail.linesAdded != null && <span>+{String(detail.linesAdded)}</span>}
                            {detail.linesRemoved != null && <span>-{String(detail.linesRemoved)}</span>}
                            {detail.testsRan != null && (
                              <span>
                                tests: {String(detail.testsPassed ?? 0)}/{String(detail.testsRan)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {eventsLoading && (
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading report timeline...
              </div>
            )}

            {/* ── Error ── */}
            {task.error && (
              <div>
                <div className="text-xs uppercase tracking-wide text-red-500 dark:text-red-400 mb-1 font-medium">
                  Error
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words bg-red-50 dark:bg-red-950/30 p-3 rounded-lg text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900">
                  {task.error}
                </pre>
              </div>
            )}

            {/* ── CLI Output (collapsible) ── */}
            {task.output && (
              <div>
                <button
                  type="button"
                  onClick={() => setOutputExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                >
                  {outputExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Worker CLI Output
                  <span className="normal-case tracking-normal font-normal text-zinc-400 dark:text-zinc-500">
                    ({(task.output.length / 1024).toFixed(1)}KB)
                  </span>
                </button>
                {outputExpanded && (
                  <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto border border-zinc-200 dark:border-zinc-700">
                    {task.output}
                  </pre>
                )}
              </div>
            )}

            {/* ── Description (collapsible) ── */}
            {task.description && (
              <div>
                <button
                  type="button"
                  onClick={() => setDescExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                >
                  {descExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Task Description (input prompt)
                </button>
                {descExpanded && (
                  <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto border border-zinc-200 dark:border-zinc-700">
                    {task.description}
                  </pre>
                )}
              </div>
            )}

            {/* ── Raw metadata ── */}
            {task.metadata != null && (
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                  Raw metadata
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-700 dark:text-zinc-200 max-h-[30vh] overflow-y-auto border border-zinc-200 dark:border-zinc-700">
                  {typeof task.metadata === 'string' ? task.metadata : JSON.stringify(task.metadata, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
