import {
  GitBranch,
  Pause,
  Play,
  Power,
  RefreshCw,
  Send,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createClusterJob,
  getClusterControlStatus,
  getClusterStatus,
  startCluster,
  stopCluster,
  listClusterHelpRequests,
  listClusterLocks,
  listClusterWorkers,
  pauseCluster,
  resumeCluster,
} from "../api";
import { getClusterApiBase } from "../config";
import type {
  ClusterHelpRequest,
  ClusterLock,
  ClusterStatus,
  ClusterWorkerRegistration,
} from "../types";

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function Card({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </div>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

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

  const [project, setProject] = useState("qqbot");
  const [desc, setDesc] = useState("");

  const sseUrl = useMemo(() => `${getClusterApiBase()}/stream`, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // Control plane is always-on (StaticServer). Use it to decide whether /api/cluster/* exists.
      const control = await getClusterControlStatus();
      setStarted(control.started);

      if (!control.started) {
        setStatus(control.status ?? null);
        setWorkers([]);
        setLocks([]);
        setHelp([]);
        return;
      }

      const [s, w, l, h] = await Promise.all([
        getClusterStatus(),
        listClusterWorkers(),
        listClusterLocks(),
        listClusterHelpRequests(),
      ]);
      setStatus(s);
      setWorkers(w);
      setLocks(l);
      setHelp(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    // Optional: SSE for instant updates (backend provides /api/cluster/stream).
    // If the cluster is not started yet, this endpoint will 404 — we fall back to polling.
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
        `runningTasks=${status.runningTasks}`,
        `pendingTasks=${status.pendingTasks}`,
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
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
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
          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Tips: 如果 cluster 未启动，部分 <span className="font-mono">/api/cluster/*</span>{" "}
            会 404。现在你可以直接在这里 Start/Stop。
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-zinc-100 dark:bg-zinc-900">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div>
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
                <div className="md:col-span-2">
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
                          });
                          setDesc("");
                          await refresh();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
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

            <Card title="Workers">
              {!workers ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  -
                </div>
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
                    .map((w) => (
                      <div
                        key={w.workerId}
                        className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
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
                        </div>
                        {w.currentTaskId && (
                          <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                            task: {w.currentTaskId}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </Card>

            <Card title="Locks">
              {!locks ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  -
                </div>
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

            <Card title="Help requests">
              {!help ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  -
                </div>
              ) : help.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  No pending requests
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {help.map((h) => (
                    <div
                      key={h.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">
                          {h.id}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {h.type} · from {h.workerId}
                        </div>
                      </div>
                      <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">
                        {h.question}
                      </div>
                      {h.context && (
                        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap">
                          {h.context}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
