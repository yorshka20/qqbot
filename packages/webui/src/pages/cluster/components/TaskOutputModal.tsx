import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, ChevronRight, FileCode, Loader2, X } from 'lucide-react';
import { marked } from 'marked';
import { useCallback, useEffect, useState } from 'react';

import { getClusterTaskEvents } from '../../../api';
import type { ClusterEventEntry, ClusterTask, ReportEventData } from '../../../types';
import { formatTimestamp } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { isReportEvent, ReportTimeline } from './ReportTimeline';

/** Safely parse hub_report summary markdown to HTML. */
function renderMarkdown(text: string): { __html: string } {
  const html = marked.parse(text, { breaks: true, gfm: true });
  return { __html: typeof html === 'string' ? html : '' };
}

function tryParseFilesModified(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [raw];
  }
}

export function TaskOutputModal({ task, onClose }: { task: ClusterTask; onClose: () => void }) {
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
  const lastReportData = (reportEvents[reportEvents.length - 1]?.data as ReportEventData | undefined) ?? undefined;
  // Prefer persisted diffSummary (set from terminal hub_report), fall back to event log
  const lastSummary = task.diffSummary || lastReportData?.summary;
  const filesModified: string[] | undefined = task.filesModified
    ? typeof task.filesModified === 'string'
      ? tryParseFilesModified(task.filesModified)
      : []
    : lastReportData?.filesModified;

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[min(90vw,72rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-white dark:bg-zinc-800 shadow-2xl flex flex-col focus:outline-none">
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
                className="p-1 rounded text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
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
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1 font-medium">
                Report Summary
              </div>
              {lastSummary ? (
                <div
                  className="text-sm text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700 max-h-[300px] overflow-y-auto prose prose-sm max-w-none dark:prose-invert prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border-collapse prose-th:border prose-td:border prose-th:border-zinc-200 prose-td:border-zinc-200 dark:prose-th:border-zinc-700 dark:prose-td:border-zinc-700 prose-th:bg-zinc-100 dark:prose-th:bg-zinc-800"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted hub_report from our own cluster workers
                  dangerouslySetInnerHTML={renderMarkdown(lastSummary)}
                />
              ) : (
                <div className="text-xs italic text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700">
                  no report summary
                </div>
              )}
            </div>

            {/* ── Files modified ── */}
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1 font-medium flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5" />
                Files Modified ({filesModified?.length ?? 0})
              </div>
              {filesModified && filesModified.length > 0 ? (
                <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-2 border border-zinc-200 dark:border-zinc-700 max-h-[150px] overflow-y-auto">
                  {filesModified.map((f) => (
                    <div key={f} className="text-xs font-mono text-zinc-700 dark:text-zinc-300 py-0.5 px-1">
                      {f}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs italic text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700">
                  no files modified
                </div>
              )}
            </div>

            {/* ── Report Timeline ── */}
            <ReportTimeline events={reportEvents} />

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

            {/* ── Live worker output: only while the scheduler still holds stdout in memory; never persisted to DB ── */}
            {task.output ? (
              <div>
                <button
                  type="button"
                  onClick={() => setOutputExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                >
                  {outputExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Live worker output
                  <span className="normal-case tracking-normal font-normal text-zinc-400 dark:text-zinc-500">
                    ({(task.output.length / 1024).toFixed(1)}KB, not saved)
                  </span>
                </button>
                {outputExpanded && (
                  <pre className="mt-1 text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto border border-zinc-200 dark:border-zinc-700">
                    {task.output}
                  </pre>
                )}
              </div>
            ) : (
              (task.status === 'completed' || task.status === 'failed') && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700">
                  Worker stdout is not stored after the task finishes. Use the report summary above and the timeline;
                  live output was only shown while the task was active.
                </div>
              )
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
