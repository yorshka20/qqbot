/**
 * Agent Cluster control page (route entry).
 *
 * Layout (single scroll column on small screens, 2-col grid above lg):
 *   - Header: status summary + Start/Stop/Pause/Resume + Refresh
 *   - Submit task card
 *   - Help requests card (with inline answer form — §2.5 round 2)
 *   - Recent jobs card (expandable to show task breakdown)
 *   - Workers card
 *   - Locks card
 *
 * Click any task in the Jobs card (or **Task output** on a worker row) to open
 * a modal with the full task record: **Output** is worker CLI stdout; hub_report
 * lines on the worker card are short checkpoints only.
 *
 * Background polling refreshes every 5s; SSE (when cluster.started) just
 * triggers a refresh on push events instead of incrementally updating
 * state — simpler, no client-side merge logic, and the backend payloads
 * are small enough that the extra round-trip is fine.
 */

import { GitBranch, History, Pause, Play, Power, RefreshCw, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createClusterJob,
  getClusterProjects,
  getClusterStatus,
  getClusterTask,
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
} from '../../api';
import { RegistryProjectSelect } from '../../components/RegistryProjectSelect';
import { TemplateSelect } from '../../components/TemplateSelect';
import { getClusterApiBase } from '../../config';
import type {
  ClusterEventEntry,
  ClusterHelpRequest,
  ClusterJob,
  ClusterLock,
  ClusterStatus,
  ClusterTask,
  ClusterTemplatesResponse,
  ClusterWorkerRegistration,
  ProjectRegistryEntry,
} from '../../types';
import { ClusterCard } from './components/ClusterCard';
import { HelpRequestRow } from './components/HelpRequestRow';
import { HistoryModal } from './components/HistoryModal';
import { JobRow } from './components/JobRow';
import { KillWorkerDialog } from './components/KillWorkerDialog';
import { TaskOutputModal } from './components/TaskOutputModal';
import { WorkerBlock } from './components/WorkerBlock';
import { CLUSTER_CARD_BODY_SCROLL, formatClusterEventSummary } from './utils';

export function ClusterPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [started, setStarted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [workers, setWorkers] = useState<ClusterWorkerRegistration[] | null>(null);
  const [locks, setLocks] = useState<ClusterLock[] | null>(null);
  const [help, setHelp] = useState<ClusterHelpRequest[] | null>(null);
  const [jobs, setJobs] = useState<ClusterJob[] | null>(null);
  const [events, setEvents] = useState<ClusterEventEntry[] | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('');
  const [templates, setTemplates] = useState<ClusterTemplatesResponse | null>(null);
  const [projects, setProjects] = useState<ProjectRegistryEntry[]>([]);

  const [project, setProject] = useState('');
  const [desc, setDesc] = useState('');
  /**
   * Explicit template override for the submit form. Empty string = "use
   * project default" (projectDefaults[project] from the templates
   * snapshot). We don't auto-update this when `project` changes because
   * the user may deliberately have picked a non-default template that
   * applies to any project — resetting on every project change would
   * throw away their selection.
   */
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');

  const [openTask, setOpenTask] = useState<ClusterTask | null>(null);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const sseUrl = useMemo(() => `${getClusterApiBase()}/stream`, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await getClusterStatus();
      setStarted(snapshot.started);

      if (!snapshot.started) {
        setStatus(snapshot.status ?? null);
        setWorkers([]);
        setLocks([]);
        setHelp([]);
        setJobs([]);
        setEvents([]);
        return;
      }

      const eventTypeArg = eventTypeFilter || undefined;

      // Cluster is running — fetch the live state in parallel. The
      // status from the snapshot above is fine to keep using here, but
      // re-pulling alongside the rest costs nothing and keeps everything
      // consistent within a single refresh tick.
      const [w, l, h, j, e] = await Promise.all([
        listClusterWorkers(),
        listClusterLocks(),
        listClusterHelpRequests(),
        listClusterJobs({ limit: 30 }),
        listClusterEvents({ type: eventTypeArg, limit: 50 }),
      ]);
      setStatus(snapshot.status);
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

  const activeWorkers = useMemo(() => {
    if (!workers) {
      return [];
    }
    const joinMs = (w: ClusterWorkerRegistration) =>
      w.spawnedAt ?? w.stats?.registeredAt ?? w.lastSeen ?? w.lastHubReportAt ?? 0;
    return workers
      .filter((w) => w.status !== 'exited')
      .slice()
      .sort((a, b) => {
        const d = joinMs(b) - joinMs(a);
        if (d !== 0) {
          return d;
        }
        return (a.workerId || '').localeCompare(b.workerId || '');
      });
  }, [workers]);

  const oldWorkers = useMemo(() => {
    if (!workers) {
      return [];
    }
    const recencyMs = (w: ClusterWorkerRegistration) =>
      w.exitedAt ?? w.spawnedAt ?? w.stats?.registeredAt ?? w.lastSeen ?? 0;
    return workers
      .filter((w) => w.status === 'exited')
      .slice()
      .sort((a, b) => {
        const d = recencyMs(b) - recencyMs(a);
        if (d !== 0) {
          return d;
        }
        return (a.workerId || '').localeCompare(b.workerId || '');
      });
  }, [workers]);

  const openTaskOutput = useCallback(async (taskId: string) => {
    try {
      setError(null);
      const raw = await getClusterTask(taskId);
      const { children, ...task } = raw;
      void children;
      setOpenTask(task as ClusterTask);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!started) {
      setTemplates(null);
      return;
    }
    getClusterTemplates()
      .then(setTemplates)
      .catch((err) => {
        console.warn('[ClusterPage] getClusterTemplates failed:', err);
      });
  }, [started]);

  // Fetch projects once on mount (always-on endpoint, doesn't require started cluster)
  const projectInitRef = useRef(false);
  useEffect(() => {
    if (projectInitRef.current) return;
    projectInitRef.current = true;
    getClusterProjects()
      .then((resp) => {
        setProjects(resp.projects);
        // Auto-select default project
        if (resp.defaultAlias) {
          setProject(resp.defaultAlias);
        } else if (resp.projects.length > 0) {
          setProject(resp.projects[0].alias);
        }
      })
      .catch((err) => {
        console.warn('[ClusterPage] getClusterProjects failed:', err);
      });
  });

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    let es: EventSource | null = null;
    if (!started) {
      return;
    }
    try {
      es = new EventSource(sseUrl);
      es.addEventListener('worker_status', () => refresh());
      es.addEventListener('help_request', () => refresh());
      es.addEventListener('task_spawned', () => refresh());
      es.addEventListener('task_output', () => refresh());
      es.addEventListener('init', () => refresh());
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
        `started=${started === null ? '-' : started ? 'true' : 'false'}`,
        `running=${status.running}`,
        `paused=${status.paused}`,
        `workers=${status.activeWorkers + status.idleWorkers}`,
        `tasks=${status.runningTasks}🏃 ${status.pendingTasks}⏳ ${status.completedTasks}✓ ${status.failedTasks}✗`,
      ].join(' · ')
    : '-';

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              <div className="font-semibold">Agent Cluster</div>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{summary}</div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
            >
              <History className="w-4 h-4" />
              历史审计
            </button>
            <button
              type="button"
              onClick={() => refresh()}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2"
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-zinc-100 dark:bg-zinc-900">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ClusterCard
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
              <div className={`grid grid-cols-1 md:grid-cols-12 gap-2 ${CLUSTER_CARD_BODY_SCROLL}`}>
                <div className="md:col-span-3">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Project</div>
                  <RegistryProjectSelect value={project} onChange={setProject} projects={projects} />
                </div>
                <div className="md:col-span-4">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Template</div>
                  <TemplateSelect
                    value={selectedTemplate}
                    onChange={setSelectedTemplate}
                    templates={templates?.templates ?? []}
                    disabled={!templates}
                    defaultLabel={`(default${
                      templates?.projectDefaults?.[project] ? `: ${templates.projectDefaults[project]}` : ''
                    })`}
                  />
                </div>
                <div className="md:col-span-12">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Description</div>
                  <textarea
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    rows={5}
                    className="w-full min-h-[120px] px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono leading-relaxed resize-y"
                    placeholder='e.g. "fix type errors in cluster api page"'
                  />
                </div>
                <div className="md:col-span-12 flex justify-end">
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
                        setDesc('');
                        await refresh();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    className="px-3 py-2 rounded-lg text-sm font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 transition-opacity flex items-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    Submit
                  </button>
                </div>
              </div>
            </ClusterCard>

            <ClusterCard title="Help requests" count={help?.length}>
              {!help ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : help.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">No pending requests</div>
              ) : (
                <div className={`flex flex-col gap-2 ${CLUSTER_CARD_BODY_SCROLL}`}>
                  {help.map((h) => (
                    <HelpRequestRow key={h.id} request={h} onAnswered={refresh} />
                  ))}
                </div>
              )}
            </ClusterCard>

            <div className="lg:col-span-2">
              <ClusterCard title="Recent jobs" count={jobs?.length}>
                {!jobs ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
                ) : jobs.length === 0 ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">No jobs yet — submit one above</div>
                ) : (
                  <div className={`flex flex-col gap-2 ${CLUSTER_CARD_BODY_SCROLL}`}>
                    {jobs.map((j) => (
                      <JobRow key={j.id} job={j} onTaskClick={setOpenTask} />
                    ))}
                  </div>
                )}
              </ClusterCard>
            </div>

            <div className="lg:col-span-2 w-full min-w-0">
              <ClusterCard
                title="Workers"
                count={workers?.length}
                right={
                  workers && workers.length > 0 ? (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400 font-normal">
                      active {activeWorkers.length} · exited {oldWorkers.length}
                    </span>
                  ) : null
                }
              >
                {!workers ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
                ) : workers.length === 0 ? (
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">No workers</div>
                ) : (
                  <div className="flex flex-col gap-2 max-h-[min(60vh,40rem)] overflow-y-auto overflow-x-hidden overscroll-contain px-0.5">
                    {/* Active workers first */}
                    {activeWorkers.length > 0 && (
                      <>
                        <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 shrink-0 sticky top-0 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm py-1 z-10">
                          Active ({activeWorkers.length})
                        </div>
                        {activeWorkers.map((w) => (
                          <WorkerBlock
                            key={w.workerId}
                            w={w}
                            onOpenTaskOutput={openTaskOutput}
                            onRequestKill={setKillConfirmId}
                          />
                        ))}
                      </>
                    )}
                    {/* Exited workers */}
                    {oldWorkers.length > 0 && (
                      <>
                        <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 shrink-0 sticky top-0 bg-white/90 dark:bg-zinc-800/90 backdrop-blur-sm py-1 z-10">
                          Exited ({oldWorkers.length})
                        </div>
                        {oldWorkers.map((w) => (
                          <WorkerBlock
                            key={w.workerId}
                            w={w}
                            onOpenTaskOutput={openTaskOutput}
                            onRequestKill={setKillConfirmId}
                          />
                        ))}
                      </>
                    )}
                  </div>
                )}
              </ClusterCard>
            </div>

            <div className="lg:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
              <div className="min-h-0 min-w-0">
                <ClusterCard
                  title="Events"
                  count={events?.length}
                  right={
                    <select
                      value={eventTypeFilter}
                      onChange={(e) => setEventTypeFilter(e.target.value)}
                      className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs max-w-[140px]"
                    >
                      <option value="">All types</option>
                      <option value="worker_joined">worker_joined</option>
                      <option value="worker_left">worker_left</option>
                      <option value="task_completed">task_completed</option>
                      <option value="task_failed">task_failed</option>
                      <option value="task_blocked">task_blocked</option>
                      <option value="worker_progress">worker_progress</option>
                      <option value="lock_acquired">lock_acquired</option>
                      <option value="lock_released">lock_released</option>
                      <option value="help_request">help_request</option>
                      <option value="message">message</option>
                    </select>
                  }
                >
                  {!events ? (
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
                  ) : events.length === 0 ? (
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">
                      No events
                      {eventTypeFilter && ` matching "${eventTypeFilter}"`}
                    </div>
                  ) : (
                    <div className={`flex flex-col gap-0.5 ${CLUSTER_CARD_BODY_SCROLL}`}>
                      {events.map((ev) => (
                        <div
                          key={`${ev.seq}-${ev.timestamp}`}
                          className="rounded-lg border border-zinc-100 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/20 px-2 py-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                        >
                          <div className="flex items-start gap-2">
                            <span className="text-zinc-400 dark:text-zinc-500 shrink-0 w-11 tabular-nums">
                              #{ev.seq}
                            </span>
                            <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-zinc-200/90 dark:bg-zinc-700/80 text-[10px] font-mono text-zinc-800 dark:text-zinc-100 max-w-[8.5rem] truncate">
                              {ev.type}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-zinc-800 dark:text-zinc-100 leading-snug break-words">
                                {formatClusterEventSummary(ev)}
                              </div>
                              {ev.sourceWorkerId ? (
                                <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono truncate mt-0.5">
                                  {ev.sourceWorkerId}
                                </div>
                              ) : null}
                            </div>
                            <time className="text-zinc-400 dark:text-zinc-500 shrink-0 text-[10px] tabular-nums whitespace-nowrap">
                              {new Date(ev.timestamp).toLocaleTimeString()}
                            </time>
                          </div>
                          <details className="mt-1.5 ml-[3.25rem]">
                            <summary className="cursor-pointer text-[10px] text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 select-none">
                              Raw payload
                            </summary>
                            <pre className="mt-1 p-2 rounded-md bg-zinc-100 dark:bg-zinc-950 text-[10px] leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                              {JSON.stringify(ev.data, null, 2)}
                            </pre>
                          </details>
                        </div>
                      ))}
                    </div>
                  )}
                </ClusterCard>
              </div>
              <div className="min-h-0 min-w-0">
                <ClusterCard title="Locks" count={locks?.length}>
                  {!locks ? (
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
                  ) : locks.length === 0 ? (
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">No active locks</div>
                  ) : (
                    <div className={`flex flex-col gap-2 ${CLUSTER_CARD_BODY_SCROLL}`}>
                      {locks
                        .slice()
                        .sort((a, b) => a.filePath.localeCompare(b.filePath))
                        .map((l) => (
                          <div
                            key={l.filePath}
                            className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
                          >
                            <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200 break-all">
                              {l.filePath}
                            </div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                              by {l.workerId} · task {l.taskId ?? '-'}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </ClusterCard>
              </div>
            </div>
          </div>
        </div>
      </div>

      {openTask && <TaskOutputModal task={openTask} onClose={() => setOpenTask(null)} />}

      <HistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} onTaskClick={setOpenTask} />

      {killConfirmId && (
        <KillWorkerDialog
          workerId={killConfirmId}
          onCancel={() => setKillConfirmId(null)}
          onConfirm={async () => {
            const id = killConfirmId;
            setKillConfirmId(null);
            try {
              await killClusterWorker(id);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}
    </div>
  );
}
