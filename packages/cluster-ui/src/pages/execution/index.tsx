/**
 * Execution tab: the submit form on top of Jobs / Workers, Tickets beside them as the other way
 * in, the event log and lock billboard folded out at the bottom, help requests in a right-side drawer.
 *
 * Polling refreshes every 5s; a stream event only triggers a refresh instead of updating state
 * incrementally, which needs no client-side merge logic.
 */

import type {
  ClusterEventEntry,
  ClusterHelpRequest,
  ClusterJob,
  ClusterLock,
  ClusterStatus,
  ClusterTask,
  ClusterWorkerRegistration,
} from '@qqbot/api-types';
import { ChevronDown, ChevronRight, HelpCircle, History, RefreshCw } from 'lucide-react';
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
} from '../../api';
import { EXECUTION_VIEWS, type ExecutionView, executionHref, routeHref } from '../../router';
import { useRefreshOnClusterEvents } from '../../stream/useClusterStream';
import { BottomPanel } from './cluster/components/BottomPanel';
import { HelpDrawer } from './cluster/components/HelpDrawer';
import { HistoryModal } from './cluster/components/HistoryModal';
import { JobsPanel } from './cluster/components/JobsPanel';
import { KillConfirmDialog } from './cluster/components/KillConfirmDialog';
import { SubmitTaskCard } from './cluster/components/SubmitTaskCard';
import { TaskOutputModal } from './cluster/components/TaskOutputModal';
import { WorkersPanel } from './cluster/components/WorkersPanel';
import { TicketsPage } from './tickets';

const REFRESH_EVENTS = ['init', 'worker_status', 'help_request', 'task_spawned', 'task_output'] as const;

const VIEW_LABEL: Record<ExecutionView, string> = { jobs: 'Jobs', workers: 'Workers', tickets: 'Tickets' };

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

function ViewLink({ view, active, count }: { view: ExecutionView; active: boolean; count?: number }) {
  return (
    <a
      href={executionHref(view)}
      className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
        active
          ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
          : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
      }`}
    >
      {VIEW_LABEL[view]}
      {typeof count === 'number' && (
        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">
          {count}
        </span>
      )}
    </a>
  );
}

export function ExecutionPage({
  active,
  view,
  ticketId,
}: {
  /** False while another tab is showing: the page stays mounted to keep drafts, but stops fetching. */
  active: boolean;
  view: ExecutionView;
  ticketId: string | null;
}) {
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

  const [submitOpen, setSubmitOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);

  const [openTask, setOpenTask] = useState<ClusterTask | null>(null);
  const [killConfirm, setKillConfirm] = useState<{ kind: 'worker' | 'task' | 'job'; id: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

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

      const [w, l, h, j, e] = await Promise.all([
        listClusterWorkers(),
        listClusterLocks(),
        listClusterHelpRequests(),
        listClusterJobs({ limit: 30 }),
        listClusterEvents({ type: eventTypeFilter || undefined, limit: 50 }),
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
      const { children, ...task } = await getClusterTask(taskId);
      void children;
      setOpenTask(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    refresh();
    const t = window.setInterval(() => refresh(), 5000);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  useRefreshOnClusterEvents(REFRESH_EVENTS, refresh, active && started === true);

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
  const counts: Partial<Record<ExecutionView, number>> = { jobs: jobs?.length, workers: workers?.length };

  return (
    <div className="h-full flex flex-col">
      {/* ── Header: resident status + controls ── */}
      <div className="shrink-0 px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
        <div className="flex items-center gap-3 flex-wrap">
          <StatusChips started={started} status={status} />
          <div className="flex-1" />
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

      {/* ── Submit form: the direct entry, parallel to Tickets, which has its own New ── */}
      <div
        className={
          view === 'tickets'
            ? 'hidden'
            : 'shrink-0 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800'
        }
      >
        <button
          type="button"
          onClick={() => setSubmitOpen((o) => !o)}
          aria-expanded={submitOpen}
          className="w-full px-4 py-2 flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
        >
          {submitOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          提交任务
        </button>
        <div className={submitOpen ? 'px-4 pb-3' : 'hidden'}>
          <SubmitTaskCard
            started={started}
            onSubmitted={() => {
              window.location.hash = executionHref('jobs');
              refresh();
            }}
          />
        </div>
      </div>

      {/* ── Main: view bar + single-scroll view body ── */}
      <main className="flex-1 min-h-0 flex flex-col bg-zinc-100 dark:bg-zinc-900">
        <div className="shrink-0 bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 px-4 flex items-center gap-1">
          {EXECUTION_VIEWS.map((v) => (
            <ViewLink key={v} view={v} active={view === v} count={counts[v]} />
          ))}
          <div className="flex-1" />
          {view === 'workers' && workers && workers.length > 0 && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              active {activeWorkers.length} · exited {oldWorkers.length}
            </span>
          )}
        </div>
        {/* All views stay mounted so expanded rows and the ticket editor survive switching */}
        <div className={view === 'tickets' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <TicketsPage selectedId={ticketId} />
        </div>
        <div className={view === 'tickets' ? 'hidden' : 'p-4 flex-1 min-h-0 overflow-y-auto overscroll-contain'}>
          {started === false ? (
            <div className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
              Cluster 未启动，到{' '}
              <a href={routeHref({ tab: 'settings' })} className="underline">
                Settings
              </a>{' '}
              启动。
            </div>
          ) : (
            <>
              <div className={view === 'jobs' ? '' : 'hidden'}>
                <JobsPanel
                  jobs={jobs}
                  onTaskClick={setOpenTask}
                  onKillJob={(id) => setKillConfirm({ kind: 'job', id })}
                  onKillTask={(id) => setKillConfirm({ kind: 'task', id })}
                />
              </div>
              <div className={view === 'workers' ? '' : 'hidden'}>
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
      <BottomPanel events={events} typeFilter={eventTypeFilter} onTypeFilterChange={setEventTypeFilter} locks={locks} />

      <HelpDrawer open={helpOpen && active} help={help} onClose={() => setHelpOpen(false)} onAnswered={refresh} />

      {openTask && <TaskOutputModal task={openTask} onClose={() => setOpenTask(null)} />}

      <HistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} onTaskClick={setOpenTask} />

      {killConfirm && (
        <KillConfirmDialog
          kind={killConfirm.kind}
          id={killConfirm.id}
          note={(() => {
            if (killConfirm.kind !== 'worker') return undefined;
            const w = workers?.find((x) => x.workerId === killConfirm.id);
            const isOrphan = !!w && w.status !== 'active' && w.status !== 'exited';
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
