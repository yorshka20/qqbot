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
 * Click any task in the Jobs card to open a modal with the full output.
 *
 * Background polling refreshes every 5s; SSE (when cluster.started) just
 * triggers a refresh on push events instead of incrementally updating
 * state — simpler, no client-side merge logic, and the backend payloads
 * are small enough that the extra round-trip is fine.
 */

import {
  GitBranch,
  Pause,
  Play,
  Power,
  RefreshCw,
  Send,
  Skull,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createClusterJob,
  getClusterControlStatus,
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
} from '../../api';
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
} from '../../types';
import { ClusterCard } from './components/ClusterCard';
import { HelpRequestRow } from './components/HelpRequestRow';
import { JobRow } from './components/JobRow';
import { KillWorkerDialog } from './components/KillWorkerDialog';
import { TaskOutputModal } from './components/TaskOutputModal';
import { formatMs } from './utils';

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

  const [project, setProject] = useState('qqbot');
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

  const sseUrl = useMemo(() => `${getClusterApiBase()}/stream`, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
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
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                <div className="md:col-span-3">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Project</div>
                  <input
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                    placeholder="qqbot"
                  />
                </div>
                <div className="md:col-span-3">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Template</div>
                  <select
                    value={selectedTemplate}
                    onChange={(e) => setSelectedTemplate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                    disabled={!templates}
                  >
                    <option value="">
                      (default
                      {templates?.projectDefaults?.[project] ? `: ${templates.projectDefaults[project]}` : ''})
                    </option>
                    {templates?.templates.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name} · {t.type} · {t.costTier}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-6">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Description</div>
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
              </div>
            </ClusterCard>

            <ClusterCard title="Help requests" count={help?.length}>
              {!help ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : help.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">No pending requests</div>
              ) : (
                <div className="flex flex-col gap-2">
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
                  <div className="flex flex-col gap-2">
                    {jobs.map((j) => (
                      <JobRow key={j.id} job={j} onTaskClick={setOpenTask} />
                    ))}
                  </div>
                )}
              </ClusterCard>
            </div>

            <ClusterCard title="Workers" count={workers?.length}>
              {!workers ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : workers.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">No workers</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {workers
                    .slice()
                    .sort((a, b) => (a.workerId || '').localeCompare(b.workerId || ''))
                    .map((w) => {
                      const isRunning = w.status === 'running' || w.status === 'active';
                      return (
                        <div
                          key={w.workerId}
                          className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 px-3 py-2"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{w.workerId}</div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              {w.project ?? '-'} · {w.templateName ?? '-'} · {w.role ?? '-'} · {w.status ?? '-'}
                            </div>
                            <div className="flex-1" />
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              lastSeen: {w.lastSeen ? formatMs(Date.now() - w.lastSeen) : '-'}
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
                            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">task: {w.currentTaskId}</div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </ClusterCard>

            <ClusterCard title="Locks" count={locks?.length}>
              {!locks ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
              ) : locks.length === 0 ? (
                <div className="text-sm text-zinc-500 dark:text-zinc-400">No active locks</div>
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
                        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-200">{l.filePath}</div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          by {l.workerId} · task {l.taskId ?? '-'}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </ClusterCard>

            <div className="lg:col-span-2">
              <ClusterCard
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
                  <div className="text-sm text-zinc-500 dark:text-zinc-400">-</div>
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
                        <div className="font-mono text-zinc-400 dark:text-zinc-500 shrink-0 w-16">#{ev.seq}</div>
                        <div className="font-mono text-zinc-600 dark:text-zinc-300 shrink-0 w-24 truncate">{ev.type}</div>
                        <div className="font-mono text-zinc-500 dark:text-zinc-400 shrink-0 truncate w-28">
                          {ev.sourceWorkerId ?? '-'}
                        </div>
                        <div className="flex-1 text-zinc-700 dark:text-zinc-200 truncate">{JSON.stringify(ev.data)}</div>
                        <div className="text-zinc-400 dark:text-zinc-500 shrink-0">
                          {new Date(ev.timestamp).toLocaleTimeString()}
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

      {openTask && <TaskOutputModal task={openTask} onClose={() => setOpenTask(null)} />}

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
