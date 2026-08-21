/**
 * Agent Cluster control page (route entry).
 *
 * Layout:
 *   - Header (resident): title, live status chips, lifecycle controls
 *     (Start/Stop/Pause/Resume), help-request badge, history audit, refresh.
 *   - Main area: Submit task / Recent jobs / Workers as full-height tabs —
 *     each tab body is the single scroll container, so lists get the whole
 *     viewport instead of nested card-sized scrollboxes. All panels stay
 *     mounted across tab switches to preserve form and expanded-row state;
 *     a successful submit jumps to Recent jobs to show the new job.
 *   - Bottom fold-out panel: event log + lock billboard, with a one-line
 *     latest-event preview when collapsed.
 *   - Help requests: right-side drawer that auto-opens when a new request
 *     arrives; toggled any time from the header badge.
 *
 * Click any task in the Jobs tab (or **Output** on a worker row) to open a
 * modal with the full task record: **Output** is worker CLI stdout;
 * hub_report lines on the worker card are short checkpoints only.
 *
 * Background polling refreshes every 5s; SSE (when cluster.started) just
 * triggers a refresh on push events instead of incrementally updating
 * state — simpler, no client-side merge logic, and the backend payloads
 * are small enough that the extra round-trip is fine.
 */

import { GitBranch, HelpCircle, History, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getClusterStatus,
  getClusterTask,
  killClusterJob,
  killClusterTask,
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
  ClusterWorkerRegistration,
} from '../../types';
import { BottomPanel } from './components/BottomPanel';
import { HelpDrawer } from './components/HelpDrawer';
import { HistoryModal } from './components/HistoryModal';
import { JobsPanel } from './components/JobsPanel';
import { KillConfirmDialog } from './components/KillConfirmDialog';
import { type ClusterLifecycleAction, LifecycleControls } from './components/LifecycleControls';
import { SubmitTaskCard } from './components/SubmitTaskCard';
import { TaskOutputModal } from './components/TaskOutputModal';
import { WorkersPanel } from './components/WorkersPanel';

type ClusterTab = 'submit' | 'jobs' | 'workers';

function StatusChips({ started, status }: { started: boolean | null; status: ClusterStatus | null }) {
  if (!status) {
    return <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">-</span>;
  }
  const state = started === false ? 'stopped' : status.paused ? 'paused' : status.running ? 'running' : 'idle';
  const dot =
    state === 'running'
      ? 'bg-emerald-500'
      : state === 'paused'
        ? 'bg-amber-500'
        : state === 'idle'
          ? 'bg-blue-400'
          : 'bg-zinc-400';
  return (
    <div className="flex items-center gap-3 text-xs font-mono text-zinc-500 dark:text-zinc-400">
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        {state}
      </span>
      <span>workers {status.activeWorkers + status.idleWorkers}</span>
      <span className="tabular-nums">
        {status.runningTasks}🏃 {status.pendingTasks}⏳ {status.completedTasks}✓ {status.failedTasks}✗
      </span>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
        active
          ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
          : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
      }`}
    >
      {label}
      {typeof count === 'number' && (
        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
          {count}
        </span>
      )}
    </button>
  );
}

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

  const [tab, setTab] = useState<ClusterTab>('jobs');
  const [helpOpen, setHelpOpen] = useState(false);

  const [openTask, setOpenTask] = useState<ClusterTask | null>(null);
  const [killConfirm, setKillConfirm] = useState<{ kind: 'worker' | 'task' | 'job'; id: string } | null>(null);
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

  const lifecycle = useCallback(
    async (action: ClusterLifecycleAction) => {
      try {
        if (action === 'start') {
          await startCluster();
        } else if (action === 'stop') {
          await stopCluster();
        } else if (action === 'pause') {
          await pauseCluster();
        } else {
          await resumeCluster();
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

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

  // Auto-open the help drawer only when a request id we haven't seen yet
  // arrives — a manual close stays closed across refreshes until the next
  // genuinely new request.
  const seenHelpIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!help) {
      return;
    }
    const hasNew = help.some((h) => !seenHelpIds.current.has(h.id));
    seenHelpIds.current = new Set(help.map((h) => h.id));
    if (hasNew && help.length > 0) {
      setHelpOpen(true);
    }
  }, [help]);

  const helpCount = help?.length ?? 0;

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full flex flex-col">
        {/* ── Header: resident status + controls ── */}
        <div className="shrink-0 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
              <div className="font-semibold">Agent Cluster</div>
            </div>
            <StatusChips started={started} status={status} />
            <div className="flex-1" />
            <LifecycleControls started={started} running={!!status?.running} onAction={lifecycle} />
            <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700" />
            <button
              type="button"
              onClick={() => setHelpOpen((o) => !o)}
              className={`relative px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                helpCount > 0
                  ? 'border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                  : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700'
              }`}
            >
              <HelpCircle className="w-3.5 h-3.5" />
              Help
              {helpCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-amber-500 text-white">
                  {helpCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1.5"
            >
              <History className="w-3.5 h-3.5" />
              历史审计
            </button>
            <button
              type="button"
              onClick={() => refresh()}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-1.5"
              disabled={loading}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        {/* ── Main: tab bar + single-scroll tab body ── */}
        <main className="flex-1 min-h-0 flex flex-col bg-zinc-100 dark:bg-zinc-900 overflow-y-auto lg:overflow-hidden">
          <div className="shrink-0 sticky top-0 z-20 lg:static bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 px-4 flex items-center gap-1">
            <TabButton active={tab === 'submit'} onClick={() => setTab('submit')} label="Submit task" />
            <TabButton
              active={tab === 'jobs'}
              onClick={() => setTab('jobs')}
              label="Recent jobs"
              count={jobs?.length}
            />
            <TabButton
              active={tab === 'workers'}
              onClick={() => setTab('workers')}
              label="Workers"
              count={workers?.length}
            />
            <div className="flex-1" />
            {tab === 'workers' && workers && workers.length > 0 && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                active {activeWorkers.length} · exited {oldWorkers.length}
              </span>
            )}
          </div>
          <div className="p-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto overscroll-contain">
            {started === false ? (
              <div className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
                Cluster is not started — press Start in the header to boot the hub.
              </div>
            ) : (
              <>
                {/* All panels stay mounted so form state and expanded rows survive tab switches */}
                <div className={tab === 'submit' ? '' : 'hidden'}>
                  <SubmitTaskCard
                    started={started}
                    onSubmitted={() => {
                      setTab('jobs');
                      refresh();
                    }}
                  />
                </div>
                <div className={tab === 'jobs' ? '' : 'hidden'}>
                  <JobsPanel
                    jobs={jobs}
                    onTaskClick={setOpenTask}
                    onKillJob={(id) => setKillConfirm({ kind: 'job', id })}
                    onKillTask={(id) => setKillConfirm({ kind: 'task', id })}
                  />
                </div>
                <div className={tab === 'workers' ? '' : 'hidden'}>
                  <WorkersPanel
                    workers={workers}
                    activeWorkers={activeWorkers}
                    oldWorkers={oldWorkers}
                    onOpenTaskOutput={openTaskOutput}
                    onRequestKill={(id) => setKillConfirm({ kind: 'worker', id })}
                  />
                </div>
              </>
            )}
          </div>
        </main>

        {/* ── Bottom fold-out panel: events + locks ── */}
        <BottomPanel
          events={events}
          typeFilter={eventTypeFilter}
          onTypeFilterChange={setEventTypeFilter}
          locks={locks}
        />
      </div>

      <HelpDrawer open={helpOpen} help={help} onClose={() => setHelpOpen(false)} onAnswered={refresh} />

      {openTask && <TaskOutputModal task={openTask} onClose={() => setOpenTask(null)} />}

      <HistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} onTaskClick={setOpenTask} />

      {killConfirm && (
        <KillConfirmDialog
          kind={killConfirm.kind}
          id={killConfirm.id}
          note={(() => {
            if (killConfirm.kind !== 'worker') return undefined;
            const w = workers?.find((x) => x.workerId === killConfirm.id);
            const isOrphan = !!w && w.status !== 'running' && w.status !== 'active' && w.status !== 'exited';
            return isOrphan
              ? 'No live process found for this worker. Confirming marks the orphan registration as exited so the UI reflects reality.'
              : undefined;
          })()}
          onCancel={() => setKillConfirm(null)}
          onConfirm={async () => {
            const confirm = killConfirm;
            setKillConfirm(null);
            try {
              if (confirm.kind === 'worker') {
                await killClusterWorker(confirm.id);
              } else if (confirm.kind === 'task') {
                await killClusterTask(confirm.id);
              } else {
                await killClusterJob(confirm.id);
              }
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
