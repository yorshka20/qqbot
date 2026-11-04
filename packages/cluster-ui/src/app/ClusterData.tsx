import type {
  ClusterDaemonHealthResponse,
  ClusterHelpRequest,
  ClusterJobWithDetail,
  ClusterLock,
  ClusterStatusResponse,
  ClusterTemplatesResponse,
  ClusterWorkerHistoryEntry,
  EnrichedWorkerRegistration,
  ProjectsResponse,
} from '@qqbot/api-types';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  getClusterJob,
  getClusterProjects,
  getClusterStatus,
  getClusterTemplates,
  getDaemonHealth,
  listClusterActiveTasks,
  listClusterHelpRequests,
  listClusterHistoryJobs,
  listClusterHistoryWorkers,
  listClusterLocks,
  listClusterWorkers,
} from '../api';
import { hasOutput, setOutput } from '../lib/outputs';
import { buildRuns, type Run, type TaskRow } from '../lib/runs';
import { isLive } from '../lib/stage';
import { toMs } from '../lib/time';
import { useNow } from '../lib/useNow';
import { useClusterStream, useClusterStreamConnected, useRefreshOnClusterEvents } from '../stream/useClusterStream';

const HISTORY_PAGE = 30;
const FALLBACK_POLL_MS = 5000;
const REFRESH_EVENTS = [
  'init',
  'worker_status',
  'help_request',
  'task_spawned',
  'task_acknowledged',
  'task_message',
] as const;

export interface ClusterData {
  loaded: boolean;
  /** Set while the daemon does not answer. */
  unreachable: boolean;
  health: ClusterDaemonHealthResponse | null;
  cluster: ClusterStatusResponse | null;
  runs: Run[];
  /** Pending questions only. */
  help: ClusterHelpRequest[];
  /** Every question, answered ones included, newest first. */
  helpHistory: ClusterHelpRequest[];
  workers: EnrichedWorkerRegistration[];
  /** Workers from the database history, exited ones included. */
  workerHistory: ClusterWorkerHistoryEntry[];
  locks: ClusterLock[];
  templates: ClusterTemplatesResponse | null;
  projects: ProjectsResponse | null;
  /** Exit time of a worker, from the job detail: `/workers` forgets workers of old jobs. */
  workerExits: ReadonlyMap<string, number>;
  hasMoreHistory: boolean;
  /** Epoch ms of the earliest loaded run, so a window switch can tell whether history is enough. */
  oldestLoadedAt: number | null;
  /** Bumped after every successful refresh, so a detail view can follow it. */
  version: number;
  refresh: () => Promise<void>;
  loadMoreHistory: () => void;
}

const Context = createContext<ClusterData | null>(null);

export function useCluster(): ClusterData {
  const data = useContext(Context);
  if (!data) {
    throw new Error('useCluster outside ClusterDataProvider');
  }
  return data;
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

interface Snapshot {
  rows: TaskRow[];
  help: ClusterHelpRequest[];
  helpHistory: ClusterHelpRequest[];
  workers: EnrichedWorkerRegistration[];
  workerHistory: ClusterWorkerHistoryEntry[];
  locks: ClusterLock[];
  workerExits: Map<string, number>;
  hasMoreHistory: boolean;
}

const EMPTY: Snapshot = {
  rows: [],
  help: [],
  helpHistory: [],
  workers: [],
  workerHistory: [],
  locks: [],
  workerExits: new Map(),
  hasMoreHistory: false,
};

/**
 * Everything the screens read comes from here, moved by the one SSE stream. Polling runs only
 * while the stream is down, and on return to a hidden tab: a phone suspends the stream's socket.
 */
export function ClusterDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [health, setHealth] = useState<ClusterDaemonHealthResponse | null>(null);
  const [cluster, setCluster] = useState<ClusterStatusResponse | null>(null);
  const [templates, setTemplates] = useState<ClusterTemplatesResponse | null>(null);
  const [projects, setProjects] = useState<ProjectsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [version, setVersion] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);

  const now = useNow();

  /** A terminal job no longer changes, so its detail is read once. */
  const finishedJobs = useRef(new Map<string, ClusterJobWithDetail | null>());
  const inFlight = useRef<Promise<void> | null>(null);
  const rerun = useRef(false);
  const running = useRef(new Set<string>());
  const historyLimitRef = useRef(historyLimit);
  historyLimitRef.current = historyLimit;

  const loadJob = useCallback(async (jobId: string, status: string): Promise<ClusterJobWithDetail | null> => {
    const known = finishedJobs.current.get(jobId);
    if (known !== undefined) {
      return known;
    }
    // The scheduler keeps a week of jobs in memory; an older one 404s and has no task rows left to show.
    const detail = await getClusterJob(jobId).catch(() => null);
    // A job ends with its root task; a planner's children can outlive it and still change.
    if (isTerminal(status) && !detail?.tasks.some(isLive)) {
      finishedJobs.current.set(jobId, detail);
    }
    return detail;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [daemon, status] = await Promise.all([getDaemonHealth(), getClusterStatus()]);
      setHealth(daemon);
      setCluster(status);
      setUnreachable(false);
      if (status.started) {
        const [active, helpHistory, workers, historyWorkers, locks, history] = await Promise.all([
          listClusterActiveTasks(),
          listClusterHelpRequests('all'),
          listClusterWorkers(),
          listClusterHistoryWorkers({ limit: 100 }),
          listClusterLocks(),
          listClusterHistoryJobs({ limit: historyLimitRef.current }),
        ]);
        const jobs = await Promise.all(history.items.map((job) => loadJob(job.id, job.status)));

        const rows = new Map<string, TaskRow>();
        const workerExits = new Map<string, number>();
        for (const job of jobs) {
          for (const task of job?.tasks ?? []) {
            rows.set(task.id, { task, ticketId: job?.ticketId });
            if (task.output && !hasOutput(task.id)) {
              setOutput(task.id, task.output);
            }
          }
          for (const worker of job?.workers ?? []) {
            if (worker.exitedAt) {
              workerExits.set(worker.workerId, worker.exitedAt);
            }
          }
        }
        for (const task of active) {
          rows.set(task.id, { task, ticketId: rows.get(task.id)?.ticketId });
          if (task.output) {
            setOutput(task.id, task.output);
          }
        }
        running.current = new Set(active.filter((t) => t.status === 'running').map((t) => t.id));
        setSnapshot({
          rows: [...rows.values()],
          help: helpHistory.filter((r) => r.status === 'pending'),
          helpHistory,
          workers,
          workerHistory: historyWorkers.items,
          locks,
          workerExits,
          hasMoreHistory: history.hasMore,
        });
      } else {
        setSnapshot((prev) => ({
          ...prev,
          help: [],
          helpHistory: [],
          workers: [],
          workerHistory: [],
          locks: [],
        }));
      }
      setVersion((v) => v + 1);
    } catch {
      setUnreachable(true);
    } finally {
      setLoaded(true);
    }
  }, [loadJob]);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) {
      rerun.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      do {
        rerun.current = false;
        await load();
      } while (rerun.current);
      inFlight.current = null;
    })();
    inFlight.current = run;
    return run;
  }, [load]);

  const started = cluster?.started === true;

  // Static config; read again across a stop/start in case the daemon came back with a new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `started` is the re-read trigger
  useEffect(() => {
    getClusterTemplates().then(setTemplates, () => {});
    getClusterProjects().then(setProjects, () => {});
  }, [started]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `historyLimit` is the re-read trigger
  useEffect(() => {
    void refresh();
  }, [refresh, historyLimit]);

  // After `POST /stop` the daemon's stream stays open and silent, so it is dropped here.
  useRefreshOnClusterEvents(REFRESH_EVENTS, refresh, started);
  useClusterStream((event, data) => {
    if (event === 'task_output') {
      const { taskId, output } = data as { taskId: string; output: string };
      setOutput(taskId, output);
      // Nothing on the stream announces a queued task starting; its first output is the signal.
      if (!running.current.has(taskId)) {
        void refresh();
      }
    }
  }, started);

  const streaming = useClusterStreamConnected();
  useEffect(() => {
    if (streaming) {
      return;
    }
    const timer = window.setInterval(() => void refresh(), FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [streaming, refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const runs = useMemo(() => buildRuns(snapshot.rows, snapshot.help, snapshot.workers, now), [snapshot, now]);

  const oldestLoadedAt = useMemo(() => {
    let oldest: number | null = null;
    for (const row of snapshot.rows) {
      const at = toMs(row.task.createdAt);
      if (at !== null && (oldest === null || at < oldest)) {
        oldest = at;
      }
    }
    return oldest;
  }, [snapshot.rows]);

  const loadMoreHistory = useCallback(() => setHistoryLimit((limit) => limit + HISTORY_PAGE), []);

  const value = useMemo<ClusterData>(
    () => ({
      loaded,
      unreachable,
      health,
      cluster,
      runs,
      help: snapshot.help,
      helpHistory: snapshot.helpHistory,
      workers: snapshot.workers,
      workerHistory: snapshot.workerHistory,
      locks: snapshot.locks,
      templates,
      projects,
      workerExits: snapshot.workerExits,
      hasMoreHistory: snapshot.hasMoreHistory,
      oldestLoadedAt,
      version,
      refresh,
      loadMoreHistory,
    }),
    [
      loaded,
      unreachable,
      health,
      cluster,
      runs,
      snapshot,
      templates,
      projects,
      oldestLoadedAt,
      version,
      refresh,
      loadMoreHistory,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
