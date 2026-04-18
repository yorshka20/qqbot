import { History, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { listClusterHistoryJobs, listClusterHistoryWorkers } from '../../../api';
import type { ClusterJob, ClusterTask, ClusterWorkerHistoryEntry } from '../../../types';
import { formatEpoch } from '../utils';
import { ClusterStatusBadge } from './ClusterStatusBadge';
import { JobRow } from './JobRow';
import { Modal } from './Modal';
import { WorkerDetailModal } from './WorkerDetailModal';

interface HistoryModalProps {
  open: boolean;
  onClose: () => void;
  onTaskClick: (task: ClusterTask) => void;
}

type Tab = 'jobs' | 'workers';

interface PageState<T> {
  items: T[];
  offset: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

function initialPageState<T>(): PageState<T> {
  return { items: [], offset: 0, total: 0, hasMore: true, loading: false, error: null };
}

const PAGE_LIMIT = 50;

export function HistoryModal({ open, onClose, onTaskClick }: HistoryModalProps) {
  const [tab, setTab] = useState<Tab>('jobs');
  const [jobsState, setJobsState] = useState<PageState<ClusterJob>>(initialPageState());
  const [workersState, setWorkersState] = useState<PageState<ClusterWorkerHistoryEntry>>(initialPageState());
  const [selectedWorker, setSelectedWorker] = useState<ClusterWorkerHistoryEntry | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Track whether initial load has happened per tab
  const jobsLoadedRef = useRef(false);
  const workersLoadedRef = useRef(false);

  const loadMoreJobs = useCallback(async (currentOffset: number) => {
    setJobsState((prev) => {
      if (prev.loading || !prev.hasMore) return prev;
      return { ...prev, loading: true, error: null };
    });
    try {
      const res = await listClusterHistoryJobs({ limit: PAGE_LIMIT, offset: currentOffset });
      setJobsState((prev) => ({
        items: currentOffset === 0 ? res.items : [...prev.items, ...res.items],
        offset: currentOffset + res.items.length,
        total: res.total,
        hasMore: res.hasMore,
        loading: false,
        error: null,
      }));
    } catch (e) {
      setJobsState((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const loadMoreWorkers = useCallback(async (currentOffset: number) => {
    setWorkersState((prev) => {
      if (prev.loading || !prev.hasMore) return prev;
      return { ...prev, loading: true, error: null };
    });
    try {
      const res = await listClusterHistoryWorkers({ limit: PAGE_LIMIT, offset: currentOffset });
      setWorkersState((prev) => ({
        items: currentOffset === 0 ? res.items : [...prev.items, ...res.items],
        offset: currentOffset + res.items.length,
        total: res.total,
        hasMore: res.hasMore,
        loading: false,
        error: null,
      }));
    } catch (e) {
      setWorkersState((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  // Initial load when tab becomes active
  useEffect(() => {
    if (!open) return;
    if (tab === 'jobs' && !jobsLoadedRef.current) {
      jobsLoadedRef.current = true;
      void loadMoreJobs(0);
    } else if (tab === 'workers' && !workersLoadedRef.current) {
      workersLoadedRef.current = true;
      void loadMoreWorkers(0);
    }
  }, [open, tab, loadMoreJobs, loadMoreWorkers]);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setJobsState(initialPageState());
      setWorkersState(initialPageState());
      setSelectedWorker(null);
      jobsLoadedRef.current = false;
      workersLoadedRef.current = false;
    }
  }, [open]);

  // Set up IntersectionObserver on sentinel div
  useEffect(() => {
    if (!open) return;
    const sentinel = sentinelRef.current;
    const container = scrollRef.current;
    if (!sentinel || !container) return;

    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        if (tab === 'jobs') {
          setJobsState((prev) => {
            if (!prev.hasMore || prev.loading) return prev;
            void loadMoreJobs(prev.offset);
            return prev;
          });
        } else {
          setWorkersState((prev) => {
            if (!prev.hasMore || prev.loading) return prev;
            void loadMoreWorkers(prev.offset);
            return prev;
          });
        }
      },
      { root: container, threshold: 0.1 },
    );
    observer.observe(sentinel);
    observerRef.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [open, tab, loadMoreJobs, loadMoreWorkers]);

  if (!open) return null;

  const currentState = tab === 'jobs' ? jobsState : workersState;

  const header = (
    <>
      <History className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">历史审计</h2>
      {currentState.total > 0 && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {currentState.items.length} / {currentState.total}
        </span>
      )}
    </>
  );

  return (
    <Modal onClose={onClose} header={header} size="xl">
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Tabs */}
        <div className="shrink-0 px-5 pt-3 flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-700">
          <button
            type="button"
            onClick={() => setTab('jobs')}
            className={`px-3 py-1.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === 'jobs'
                ? 'border-zinc-800 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
            }`}
          >
            Jobs
          </button>
          <button
            type="button"
            onClick={() => setTab('workers')}
            className={`px-3 py-1.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === 'workers'
                ? 'border-zinc-800 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
            }`}
          >
            Workers
          </button>
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-3">
          {currentState.error && (
            <div className="text-sm text-red-600 dark:text-red-400 mb-3">{currentState.error}</div>
          )}

          {tab === 'jobs' && (
            <div className="flex flex-col gap-2">
              {jobsState.items.map((job) => (
                <JobRow key={job.id} job={job} onTaskClick={onTaskClick} />
              ))}
            </div>
          )}

          {tab === 'workers' && (
            <div className="flex flex-col gap-1">
              {workersState.items.map((w) => (
                <WorkerHistoryRow
                  key={`${w.workerId}-${w.stats?.registeredAt ?? w.spawnedAt ?? 0}`}
                  worker={w}
                  onClick={() => setSelectedWorker(w)}
                />
              ))}
            </div>
          )}

          {/* Loading spinner */}
          {currentState.loading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
            </div>
          )}

          {/* Empty state */}
          {!currentState.loading && currentState.items.length === 0 && (
            <div className="text-sm text-zinc-500 dark:text-zinc-400 py-8 text-center">No {tab} history</div>
          )}

          {/* Sentinel for IntersectionObserver */}
          <div ref={sentinelRef} className="h-1" />
        </div>
      </div>
      {selectedWorker && <WorkerDetailModal worker={selectedWorker} onClose={() => setSelectedWorker(null)} />}
    </Modal>
  );
}

function WorkerHistoryRow({ worker, onClick }: { worker: ClusterWorkerHistoryEntry; onClick: () => void }) {
  const registeredAt = worker.stats?.registeredAt ?? worker.spawnedAt;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-800/30 px-3 py-2 flex items-center gap-2 text-xs text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
    >
      <span
        className="font-mono text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[8rem] truncate"
        title={worker.workerId}
      >
        {worker.workerId?.slice(0, 14) ?? '-'}
      </span>
      {worker.role && (
        <span className="shrink-0 px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 text-[10px] font-mono">
          {worker.role}
        </span>
      )}
      <ClusterStatusBadge status={worker.status ?? 'unknown'} />
      {worker.templateName && (
        <span className="shrink-0 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-mono text-[10px]">
          {worker.templateName}
        </span>
      )}
      {worker.project && <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{worker.project}</span>}
      <span className="flex-1 min-w-0 truncate text-zinc-600 dark:text-zinc-300" title={worker.lastReportSummary}>
        {worker.lastReportSummary ?? ''}
      </span>
      <span className="shrink-0 text-zinc-400 dark:text-zinc-500 tabular-nums">{formatEpoch(registeredAt)}</span>
      {worker.exitedAt != null && (
        <span className="shrink-0 text-zinc-400 dark:text-zinc-500 tabular-nums">→ {formatEpoch(worker.exitedAt)}</span>
      )}
    </button>
  );
}
