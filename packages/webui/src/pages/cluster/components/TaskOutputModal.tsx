import * as Dialog from '@radix-ui/react-dialog';
import { Copy, FileCode, Loader2, WrapText, X } from 'lucide-react';
import { marked } from 'marked';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getClusterTask, getClusterTaskEvents } from '../../../api';
import type { ClusterEventEntry, ClusterTask, ReportEventData } from '../../../types';
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

function fmtShort(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const NON_TERMINAL_STATUSES = new Set(['pending', 'claimed', 'running']);

type ModalTab = 'output' | 'summary' | 'prompt';

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
          : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Full task record viewer with three tabs:
 *   - Output: report timeline down the left, live stdout on the right —
 *     side by side so checkpoints can be read against the raw output.
 *   - Summary: final hub_report markdown + files modified + error.
 *   - Prompt: the task description that was fed to the worker.
 *
 * While the task is non-terminal the record and its events are re-polled
 * every 2s and the output pane follows the tail unless the user scrolled up.
 * Opens on Output for live tasks (or when stdout is still held in memory),
 * on Summary for finished ones whose stdout is already gone.
 */
export function TaskOutputModal({ task: initialTask, onClose }: { task: ClusterTask; onClose: () => void }) {
  const [task, setTask] = useState(initialTask);
  const [events, setEvents] = useState<ClusterEventEntry[] | null>(null);
  const [tab, setTab] = useState<ModalTab>(() =>
    NON_TERMINAL_STATUSES.has(initialTask.status) || initialTask.output ? 'output' : 'summary',
  );
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  // The caller's snapshot may come from a list endpoint that caps
  // description/output for payload size (e.g. /jobs/:id); it is only good
  // enough for the first paint. Always re-fetch the authoritative record
  // from /tasks/:id, which returns the full fields.
  useEffect(() => {
    setTask(initialTask);
    let cancelled = false;
    (async () => {
      try {
        const raw = await getClusterTask(initialTask.id);
        const { children, ...next } = raw as ClusterTask & { children?: unknown };
        void children;
        if (!cancelled) {
          setTask(next as ClusterTask);
        }
      } catch {
        // Keep the snapshot; the live poll below retries for active tasks
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialTask]);

  const live = NON_TERMINAL_STATUSES.has(task.status);

  const loadEvents = useCallback(async () => {
    try {
      const evts = await getClusterTaskEvents(initialTask.id);
      setEvents(evts);
    } catch {
      // Non-critical — timeline just won't show
      setEvents((prev) => prev ?? []);
    }
  }, [initialTask.id]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (!live) {
      return;
    }
    const t = window.setInterval(async () => {
      try {
        const raw = await getClusterTask(initialTask.id);
        const { children, ...next } = raw as ClusterTask & { children?: unknown };
        void children;
        setTask(next as ClusterTask);
      } catch {
        // Keep the last snapshot; polling retries on the next tick
      }
      loadEvents();
    }, 2000);
    return () => window.clearInterval(t);
  }, [live, initialTask.id, loadEvents]);

  // Follow the output tail while the user is pinned to the bottom; a manual
  // scroll up releases the pin until they return to the bottom themselves.
  const outRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const onOutScroll = useCallback(() => {
    const el = outRef.current;
    if (el) {
      atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on output content and tab visibility, read via ref inside the effect
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [task.output, tab]);

  const reportEvents = events?.filter(isReportEvent) ?? [];
  const lastReportData = (reportEvents[reportEvents.length - 1]?.data as ReportEventData | undefined) ?? undefined;
  // Prefer persisted diffSummary (set from terminal hub_report), fall back to event log
  const lastSummary = task.diffSummary || lastReportData?.summary;
  const filesModified: string[] | undefined = task.filesModified
    ? typeof task.filesModified === 'string'
      ? tryParseFilesModified(task.filesModified)
      : []
    : lastReportData?.filesModified;

  const handleCopy = useCallback(() => {
    if (!task.output) return;
    navigator.clipboard.writeText(task.output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [task.output]);

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 h-[92vh] w-[min(96vw,100rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-white dark:bg-zinc-800 shadow-2xl flex flex-col focus:outline-none">
          {/* ── Header: identity + all scalar metadata + tabs ── */}
          <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-700">
            <div className="px-4 pt-3 pb-1.5 flex items-center gap-3">
              <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Task {task.id.slice(0, 8)}
              </Dialog.Title>
              <ClusterStatusBadge status={task.status} />
              {live && (
                <span className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  live
                </span>
              )}
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
            <div className="px-4 pb-1.5 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
              <span>{task.workerTemplate ?? '-'}</span>
              <span>worker {task.workerId?.slice(0, 12) ?? '-'}</span>
              <span className="tabular-nums">created {fmtShort(task.createdAt)}</span>
              <span className="tabular-nums">started {fmtShort(task.startedAt)}</span>
              <span className="tabular-nums">completed {fmtShort(task.completedAt)}</span>
            </div>
            <div className="px-4 flex items-center gap-1">
              <TabBtn active={tab === 'output'} onClick={() => setTab('output')} label="Output" />
              <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')} label="Summary" />
              <TabBtn active={tab === 'prompt'} onClick={() => setTab('prompt')} label="Prompt" />
            </div>
          </div>

          {/* ── Output tab: timeline (left) vs live stdout (right) ── */}
          {tab === 'output' && (
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
              <div className="lg:w-[24rem] xl:w-[28rem] lg:shrink-0 min-h-0 max-h-[40vh] lg:max-h-none flex flex-col border-b lg:border-b-0 lg:border-r border-zinc-200 dark:border-zinc-700">
                <div className="shrink-0 px-4 py-2 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-2 bg-zinc-50 dark:bg-zinc-900/60">
                  <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium">
                    Report timeline
                  </span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">({reportEvents.length})</span>
                  {!events && (
                    <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      loading
                    </span>
                  )}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-2">
                  {reportEvents.length > 0 ? (
                    <ReportTimeline events={reportEvents} />
                  ) : (
                    <div className="text-xs italic text-zinc-400 dark:text-zinc-500">no reports yet</div>
                  )}
                </div>
              </div>

              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="shrink-0 px-4 py-2 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3 bg-zinc-50 dark:bg-zinc-900/60">
                  <span className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-medium">
                    Live worker output
                  </span>
                  {task.output && (
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      {((task.outputBytes ?? task.output.length) / 1024).toFixed(1)}KB
                      {task.outputTruncated ? ' · truncated' : ''}
                    </span>
                  )}
                  <div className="flex-1" />
                  {task.output && (
                    <>
                      <button
                        type="button"
                        onClick={() => setWrap((v) => !v)}
                        aria-pressed={wrap}
                        title={
                          wrap
                            ? 'Line wrap on — click to scroll horizontally instead'
                            : 'Line wrap off — click to wrap long lines'
                        }
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-colors ${
                          wrap
                            ? 'border-zinc-300 dark:border-zinc-500 bg-zinc-200 dark:bg-zinc-600 text-zinc-900 dark:text-zinc-100'
                            : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                        }`}
                      >
                        <WrapText className="w-3.5 h-3.5" />
                        Wrap
                      </button>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-xs text-zinc-700 dark:text-zinc-200 transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </>
                  )}
                </div>
                <div
                  ref={outRef}
                  onScroll={onOutScroll}
                  className="flex-1 min-h-0 overflow-auto overscroll-contain bg-zinc-100 dark:bg-zinc-900 p-3"
                >
                  {task.output ? (
                    <pre
                      className={`text-xs leading-relaxed font-mono text-zinc-800 dark:text-zinc-100 ${
                        wrap ? 'whitespace-pre-wrap break-words max-w-full' : 'whitespace-pre'
                      }`}
                    >
                      {task.output}
                    </pre>
                  ) : (
                    (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        Worker stdout is not stored after the task finishes. Use the Summary tab and the timeline; live
                        output was only shown while the task was active.
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Summary tab: final report + files modified + error ── */}
          {tab === 'summary' && (
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5">
              <div className="max-w-4xl mx-auto space-y-5">
                {lastSummary ? (
                  <div
                    className="text-sm text-zinc-800 dark:text-zinc-100 prose prose-sm max-w-none dark:prose-invert prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border-collapse prose-th:border prose-td:border prose-th:border-zinc-200 prose-td:border-zinc-200 dark:prose-th:border-zinc-700 dark:prose-td:border-zinc-700 prose-th:bg-zinc-100 dark:prose-th:bg-zinc-800"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted hub_report from our own cluster workers
                    dangerouslySetInnerHTML={renderMarkdown(lastSummary)}
                  />
                ) : (
                  <div className="text-xs italic text-zinc-400 dark:text-zinc-500">no report summary yet</div>
                )}

                <div>
                  <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1 font-medium flex items-center gap-1.5">
                    <FileCode className="w-3.5 h-3.5" />
                    Files Modified ({filesModified?.length ?? 0})
                  </div>
                  {filesModified && filesModified.length > 0 ? (
                    <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-2 border border-zinc-200 dark:border-zinc-700">
                      {filesModified.map((f) => (
                        <div
                          key={f}
                          className="text-xs font-mono text-zinc-700 dark:text-zinc-300 py-0.5 px-1 break-all"
                        >
                          {f}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs italic text-zinc-400 dark:text-zinc-500">no files modified</div>
                  )}
                </div>

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
              </div>
            </div>
          )}

          {/* ── Prompt tab: the task description fed to the worker ── */}
          {tab === 'prompt' && (
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5">
              <div className="max-w-4xl mx-auto">
                {task.description ? (
                  <pre className="text-xs whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-100 leading-relaxed">
                    {task.description}
                  </pre>
                ) : (
                  <div className="text-xs italic text-zinc-400 dark:text-zinc-500">no task description</div>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
