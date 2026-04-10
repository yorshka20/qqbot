/**
 * Agent Cluster control page.
 *
 * Layout (single scroll column on small screens, 2-col grid above lg):
 *   - Header: status summary + Start/Stop/Pause/Resume + Refresh
 *   - Submit task card
 *   - Help requests card (with inline answer form — §2.5 round 2)
 *   - Recent jobs card (expandable to show task breakdown)
 *   - Workers card
 *   - Locks card
 *
 * Click any task in the Jobs card to open a modal with the full output.
 *
 * Background polling refreshes every 5s; SSE (when cluster.started) just
 * triggers a refresh on push events instead of incrementally updating
 * state — simpler, no client-side merge logic, and the backend payloads
 * are small enough that the extra round-trip is fine.
 */

import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  HelpCircle,
  Pause,
  Play,
  Power,
  RefreshCw,
  Send,
  Skull,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  answerClusterHelpRequest,
  createClusterJob,
  getClusterControlStatus,
  getClusterJob,
  getClusterStatus,
  getClusterTemplates,
  killClusterWorker,
  listClusterEvents,
  listClusterHelpRequests,
  listClusterJobs,
  listClusterLocks,
  listClusterWorkers,
  pauseCluster,
  resumeCluster,
  startCluster,
  stopCluster,
} from "../api";
import { getClusterApiBase } from "../config";
import type {
  ClusterEventEntry,
  ClusterHelpRequest,
  ClusterJob,
  ClusterJobWithTasks,
  ClusterLock,
  ClusterStatus,
  ClusterTask,
  ClusterTemplatesResponse,
  ClusterWorkerRegistration,
} from "../types";

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300";
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300";
    case "running":
    case "in_progress":
      return "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300";
    case "pending":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300";
    case "blocked":
      return "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-md text-xs font-medium ${statusBadgeClass(status)}`}
    >
      {status}
    </span>
  );
}

// ─── shared card shell ───────────────────────────────────────────────────────

function Card({
  title,
  count,
  children,
  right,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </div>
        {typeof count === "number" && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
            ({count})
          </div>
        )}
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

// ─── Task output modal ───────────────────────────────────────────────────────

function TaskOutputModal({
  task,
  onClose,
}: {
  task: ClusterTask;
  onClose: () => void;
}) {
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
          <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
            <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Task {task.id.slice(0, 8)}
            </Dialog.Title>
            <StatusBadge status={task.status} />
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate min-w-0">
              {task.workerTemplate ?? "-"} · worker {task.workerId ?? "-"}
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
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">
                Description
              </div>
              <div className="text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">
                {task.description}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">
                  Created
                </div>
                {formatTimestamp(task.createdAt)}
              </div>
              <div>
                <div className="font-medium text-zinc-700 dark:text-zinc-300">
                  Completed
                </div>
                {formatTimestamp(task.completedAt)}
              </div>
            </div>
            {task.output && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">
                  Output
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-800 dark:text-zinc-100 max-h-[40vh] overflow-y-auto">
                  {task.output}
                </pre>
              </div>
            )}
            {task.error && (
              <div>
                <div className="text-xs uppercase tracking-wide text-red-500 dark:text-red-400 mb-1">
                  Error
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words bg-red-50 dark:bg-red-950/30 p-3 rounded-lg text-red-700 dark:text-red-300">
                  {task.error}
                </pre>
              </div>
            )}
            {task.metadata != null && (
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                  Raw metadata
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words bg-zinc-100 dark:bg-zinc-900 p-3 rounded-lg text-zinc-700 dark:text-zinc-200 max-h-[30vh] overflow-y-auto">
                  {typeof task.metadata === "string"
                    ? task.metadata
                    : JSON.stringify(task.metadata, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Help request answer form ────────────────────────────────────────────────

function HelpRequestRow({
  request,
  onAnswered,
}: {
  request: ClusterHelpRequest;
  onAnswered: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!answer.trim()) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      // answeredBy = "webui" surfaces in the worker's incoming message and
      // in the audit log so it's visually distinct from QQ-owner replies
      // (which use "qq:<userId>" — see ClusterCommandHandler.handleAsk).
      await answerClusterHelpRequest(request.id, {
        answer: answer.trim(),
        answeredBy: "webui",
      });
      setAnswer("");
      setExpanded(false);
      onAnswered();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [answer, request.id, onAnswered]);

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2">
      <div className="flex items-start gap-2">
        <HelpCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
              {request.id.slice(0, 8)}
            </div>
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-200/60 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200">
              {request.type}
            </span>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              from {request.workerId}
            </div>
          </div>
          <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">
            {request.question}
          </div>
          {request.context && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap">
              {request.context}
            </div>
          )}
          {request.options && request.options.length > 0 && (
            <ul className="mt-1 text-xs text-zinc-700 dark:text-zinc-200 list-decimal list-inside">
              {request.options.map((opt) => (
                <li key={opt}>{opt}</li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            {!expanded ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="px-2 py-1 rounded text-xs font-medium border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30"
              >
                Reply
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm"
                  placeholder="Your answer to the worker..."
                  disabled={submitting}
                />
                {localError && (
                  <div className="text-xs text-red-600 dark:text-red-400">
                    {localError}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={submitting || !answer.trim()}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                  >
                    {submitting ? "Sending..." : "Send answer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExpanded(false);
                      setAnswer("");
                      setLocalError(null);
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                  >
                    Cancel
                  </button>
                  <div className="flex-1" />
                  <div className="text-xs text-zinc-400 dark:text-zinc-500">
                    answeredBy=webui
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Job row (with expandable task list) ─────────────────────────────────────

function JobRow({
  job,
  onTaskClick,
}: {
  job: ClusterJob;
  onTaskClick: (task: ClusterTask) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ClusterJobWithTasks | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (detail) return; // already loaded once; refetch happens via parent refresh
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const d = await getClusterJob(job.id);
      setDetail(d);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  }, [expanded, detail, job.id]);

  // When the job list refreshes externally, drop our detail cache so the next
  // expand re-fetches. We can't just compare task counts here because tasks
  // mutate in place (status flip from pending → running → completed).
  // Cheapest correctness fix: invalidate on any job field change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional drop
  useEffect(() => {
    setDetail(null);
  }, [job.tasksCompleted, job.tasksFailed, job.status]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
        )}
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
          {job.id.slice(0, 8)}
        </div>
        <StatusBadge status={job.status} />
        <div className="text-sm text-zinc-800 dark:text-zinc-100 truncate min-w-0 flex-1">
          {job.description}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0 font-mono">
          {job.tasksCompleted}✓ {job.tasksFailed}✗ /{job.taskCount}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 bg-zinc-50/50 dark:bg-zinc-900/50">
          <div className="grid grid-cols-2 gap-2 text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            <div>
              project: <span className="font-mono">{job.project}</span>
            </div>
            <div>created: {formatTimestamp(job.createdAt)}</div>
          </div>
          {loadingDetail && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Loading tasks...
            </div>
          )}
          {detailError && (
            <div className="text-xs text-red-600 dark:text-red-400">
              {detailError}
            </div>
          )}
          {detail && detail.tasks.length === 0 && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              No tasks (job completed and tasks were drained from activeTasks)
            </div>
          )}
          {detail && detail.tasks.length > 0 && (
            <div className="flex flex-col gap-1">
              {detail.tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTaskClick(t)}
                  className="rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-left hover:bg-white dark:hover:bg-zinc-800 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-xs text-zinc-600 dark:text-zinc-300">
                      {t.id.slice(0, 8)}
                    </div>
                    <StatusBadge status={t.status} />
                    {t.workerTemplate && (
                      <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                        {t.workerTemplate}
                      </div>
                    )}
                    <div className="flex-1" />
                    <div className="text-xs text-zinc-400 dark:text-zinc-500">
                      {formatTimestamp(t.completedAt ?? t.createdAt)}
                    </div>
                  </div>
                  {t.output && (
                    <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 truncate">
                      {t.output.slice(0, 120)}
                      {t.output.length > 120 ? "…" : ""}
                    </div>
                  )}
                  {t.error && (
                    <div className="mt-1 text-xs text-red-600 dark:text-red-400 truncate">
                      {t.error}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function ClusterPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [started, setStarted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [workers, setWorkers] = useState<ClusterWorkerRegistration[] | null>(
    null,
  );
  const [locks, setLocks] = useState<ClusterLock[] | null>(null);
  const [help, setHelp] = useState<ClusterHelpRequest[] | null>(null);
  const [jobs, setJobs] = useState<ClusterJob[] | null>(null);
  const [events, setEvents] = useState<ClusterEventEntry[] | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("");
  const [templates, setTemplates] = useState<ClusterTemplatesResponse | null>(
    null,
  );

  const [project, setProject] = useState("qqbot");
  const [desc, setDesc] = useState("");
  /**
   * Explicit template override for the submit form. Empty string = "use
   * project default" (projectDefaults[project] from the templates
   * snapshot). We don't auto-update this when `project` changes because
   * the user may deliberately have picked a non-default template that
   * applies to any project — resetting on every project change would
   * throw away their selection.
   */
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");

  const [openTask, setOpenTask] = useState<ClusterTask | null>(null);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);

  const sseUrl = useMemo(() => `${getClusterApiBase()}/stream`, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // Control plane is always-on (StaticServer). Use it to decide whether
      // /api/cluster/* exists.
      const control = await getClusterControlStatus();
      setStarted(control.started);

      if (!control.started) {
        setStatus(control.status ?? null);
        setWorkers([]);
        setLocks([]);
        setHelp([]);
        setJobs([]);
        setEvents([]);
        return;
      }

      // Events query is filter-aware: empty string means "all types".
      // We intentionally pass undefined (not "") so the backend doesn't
      // try to match against an empty filter value.
      const eventTypeArg = eventTypeFilter || undefined;

      const [s, w, l, h, j, e] = await Promise.all([
        getClusterStatus(),
        listClusterWorkers(),
        listClusterLocks(),
        listClusterHelpRequests(),
        listClusterJobs({ limit: 30 }),
        listClusterEvents({ type: eventTypeArg, limit: 50 }),
      ]);
      setStatus(s);
      setWorkers(w);
      setLocks(l);
      setHelp(h);
      setJobs(j);
      setEvents(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [eventTypeFilter]);

  // Templates are cluster-config-static so we only need to fetch them once
  // per started cluster. Separate from refresh() to avoid paying the cost
  // every 5s on polling. Cleared on stop so a template edit after restart
  // gets picked up on the next start.
  useEffect(() => {
    if (!started) {
      setTemplates(null);
      return;
    }
    getClusterTemplates()
      .then(setTemplates)
      .catch((err) => {
        // Non-fatal — the submit form will just hide the template picker.
        // Keep the error quiet here (don't blow up the main error banner
        // for a feature that degrades cleanly).
        // eslint-disable-next-line no-console
        console.warn("[ClusterPage] getClusterTemplates failed:", err);
      });
  }, [started]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    // Optional: SSE for instant updates (backend provides /api/cluster/stream).
    // If the cluster is not started yet, this endpoint will 404 — we fall back
    // to polling. SSE handlers just trigger refresh() rather than maintaining
    // incremental client state — simpler, the payloads are small.
    let es: EventSource | null = null;
    if (!started) {
      return;
    }
    try {
      es = new EventSource(sseUrl);
      es.addEventListener("worker_status", () => refresh());
      es.addEventListener("help_request", () => refresh());
      es.addEventListener("init", () => refresh());
      es.onerror = () => {
        es?.close();
      };
    } catch {
      // Ignore (polling remains active)
    }
    return () => {
      es?.close();
    };
  }, [refresh, sseUrl, started]);

  const summary = status
    ? [
        `started=${started === null ? "-" : started ? "true" : "false"}`,
        `running=${status.running}`,
        `paused=${status.paused}`,
        `workers=${status.activeWorkers + status.idleWorkers}`,
        `tasks=${status.runningTasks}🏃 ${status.pendingTasks}⏳ ${status.completedTasks}✓ ${status.failedTasks}✗`,
      ].join(" · ")
    : "-";

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              <div className="font-semibold">Agent Cluster</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              {summary}
            </div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => refresh()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
              disabled={loading}
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
          {error && (
            <div className="mt-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-zinc-100 dark:bg-zinc-900">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Controls + submit */}
            <Card
              title="Controls"
              right={
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await startCluster();
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors flex items-center gap-2"
                    disabled={started === true}
                  >
                    <Power className="w-4 h-4" />
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await stopCluster();
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors flex items-center gap-2"
                    disabled={started === false}
                  >
                    <Square className="w-4 h-4" />
                    Stop
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await pauseCluster();
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
                    disabled={!status?.running}
                  >
                    <Pause className="w-4 h-4" />
                    Pause
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await resumeCluster();
                        await refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
                    disabled={!status?.running}
                  >
                    <Play className="w-4 h-4" />
                    Resume
                  </button>
                </div>
              }
            >
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                <div className="md:col-span-3">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                    Project
                  </div>
                  <input
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                    placeholder="qqbot"
                  />
                </div>
                <div className="md:col-span-3">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                    Template
                  </div>
                  <select
                    value={selectedTemplate}
                    onChange={(e) => setSelectedTemplate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                    disabled={!templates}
                  >
                    <option value="">
                      (default
                      {templates?.projectDefaults?.[project]
                        ? `: ${templates.projectDefaults[project]}`
                        : ""}
                      )
                    </option>
                    {templates?.templates.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name} · {t.type} · {t.costTier}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-6">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                    Description
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={desc}
                      onChange={(e) => setDesc(e.target.value)}
                      className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                      placeholder='e.g. "fix type errors in cluster api page"'
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          if (!project.trim() || !desc.trim()) return;
                          await createClusterJob({
                            project: project.trim(),
                            description: desc.trim(),
                            workerTemplate: selectedTemplate || undefined,
                          });
                          setDesc("");
                          await refresh();
                        } catch (err) {
                          setError(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      }}
                      className="px-3 py-2 rounded-lg text-sm font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 transition-opacity flex items-center gap-2"
                    >
                      <Send className="w-4 h-4" />
                      Submit
                    </button>
                  </div>
                </div>
              </div>
            </Card>

            {/* Help requests with answer form */}
            <Card title="Help requests" count={help?.length}>
              {!help ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : help.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  No pending requests
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {help.map((h) => (
                    <HelpRequestRow
                      key={h.id}
                      request={h}
                      onAnswered={refresh}
                    />
                  ))}
                </div>
              )}
            </Card>

            {/* Recent jobs (full width on lg+) */}
            <div className="lg:col-span-2">
              <Card title="Recent jobs" count={jobs?.length}>
                {!jobs ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">
                    -
                  </div>
                ) : jobs.length === 0 ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">
                    No jobs yet — submit one above
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {jobs.map((j) => (
                      <JobRow key={j.id} job={j} onTaskClick={setOpenTask} />
                    ))}
                  </div>
                )}
              </Card>
            </div>

            {/* Workers */}
            <Card title="Workers" count={workers?.length}>
              {!workers ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : workers.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  No workers
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {workers
                    .slice()
                    .sort((a, b) =>
                      (a.workerId || "").localeCompare(b.workerId || ""),
                    )
                    .map((w) => {
                      // A worker is "kill-worthy" only when it's actively
                      // running on the OS — exited entries hang around in
                      // recentlyExited for observability but there's nothing
                      // left to SIGKILL. Hiding the button in the exited
                      // case prevents the "killed: false" no-op response
                      // from confusing users.
                      const isRunning =
                        w.status === "running" || w.status === "active";
                      return (
                        <div
                          key={w.workerId}
                          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                              {w.workerId}
                            </div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              {w.project ?? "-"} · {w.templateName ?? "-"} ·{" "}
                              {w.role ?? "-"} · {w.status ?? "-"}
                            </div>
                            <div className="flex-1" />
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              lastSeen:{" "}
                              {w.lastSeen
                                ? formatMs(Date.now() - w.lastSeen)
                                : "-"}
                            </div>
                            {isRunning && (
                              <button
                                type="button"
                                onClick={() => setKillConfirmId(w.workerId)}
                                className="p-1 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                                aria-label={`Kill worker ${w.workerId}`}
                                title="Kill worker"
                              >
                                <Skull className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                          {w.currentTaskId && (
                            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                              task: {w.currentTaskId}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </Card>

            {/* Locks */}
            <Card title="Locks" count={locks?.length}>
              {!locks ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : locks.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  No active locks
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {locks
                    .slice()
                    .sort((a, b) => a.filePath.localeCompare(b.filePath))
                    .map((l) => (
                      <div
                        key={l.filePath}
                        className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
                      >
                        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                          {l.filePath}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          by {l.workerId} · task {l.taskId ?? "-"}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </Card>

            {/* Events feed (full width on lg+) */}
            <div className="lg:col-span-2">
              <Card
                title="Events"
                count={events?.length}
                right={
                  <select
                    value={eventTypeFilter}
                    onChange={(e) => setEventTypeFilter(e.target.value)}
                    className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
                  >
                    <option value="">All types</option>
                    <option value="worker_joined">worker_joined</option>
                    <option value="worker_left">worker_left</option>
                    <option value="task_completed">task_completed</option>
                    <option value="task_failed">task_failed</option>
                    <option value="lock_acquired">lock_acquired</option>
                    <option value="lock_released">lock_released</option>
                    <option value="help_request">help_request</option>
                    <option value="message">message</option>
                  </select>
                }
              >
                {!events ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">
                    -
                  </div>
                ) : events.length === 0 ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">
                    No events{eventTypeFilter && ` matching "${eventTypeFilter}"`}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 max-h-[40vh] overflow-y-auto">
                    {events.map((ev) => (
                      <div
                        key={`${ev.seq}-${ev.timestamp}`}
                        className="flex items-start gap-2 px-2 py-1 rounded text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                      >
                        <div className="font-mono text-zinc-400 dark:text-zinc-500 shrink-0 w-16">
                          #{ev.seq}
                        </div>
                        <div className="font-mono text-zinc-600 dark:text-zinc-300 shrink-0 w-24 truncate">
                          {ev.type}
                        </div>
                        <div className="font-mono text-zinc-500 dark:text-zinc-400 shrink-0 truncate w-28">
                          {ev.sourceWorkerId ?? "-"}
                        </div>
                        <div className="flex-1 text-zinc-700 dark:text-zinc-200 truncate">
                          {JSON.stringify(ev.data)}
                        </div>
                        <div className="text-zinc-400 dark:text-zinc-500 shrink-0">
                          {new Date(ev.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </div>
      </div>

      {openTask && (
        <TaskOutputModal task={openTask} onClose={() => setOpenTask(null)} />
      )}

      {killConfirmId && (
        <Dialog.Root
          open={true}
          onOpenChange={(o) => {
            if (!o) setKillConfirmId(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white dark:bg-zinc-800 shadow-2xl p-5 focus:outline-none">
              <Dialog.Title className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                Kill worker?
              </Dialog.Title>
              <div className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
                This sends SIGKILL to{" "}
                <span className="font-mono">{killConfirmId}</span> and its
                current task will be marked as failed. This is NOT a graceful
                shutdown — in-flight work is lost.
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setKillConfirmId(null)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const id = killConfirmId;
                    setKillConfirmId(null);
                    try {
                      await killClusterWorker(id);
                      await refresh();
                    } catch (err) {
                      setError(
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 flex items-center gap-2"
                >
                  <Skull className="w-4 h-4" />
                  Kill
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}
