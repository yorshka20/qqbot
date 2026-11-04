import type { ClusterWorkerHistoryEntry, ClusterWorkerRegistration } from '@qqbot/api-types';
import type { Run } from './runs';
import type { Tone } from './stage';

export interface WorkerResult {
  label: string;
  tone: Tone;
}

const DAY = 24 * 60 * 60 * 1000;

/** How a worker's last report reads; a worker that never reported is told apart by whether it still runs. */
export function workerResult(entry: Pick<ClusterWorkerHistoryEntry, 'lastReportStatus' | 'exitedAt'>): WorkerResult {
  switch (entry.lastReportStatus) {
    case 'completed':
      return { label: '已完成', tone: 'done' };
    case 'failed':
      return { label: '失败', tone: 'failed' };
    case 'blocked':
      return { label: '受阻', tone: 'failed' };
    default:
      return entry.exitedAt !== undefined ? { label: '已退出', tone: 'muted' } : { label: '进行中', tone: 'working' };
  }
}

export function exitedWorkers(
  history: ClusterWorkerHistoryEntry[],
  now: number,
  days: number,
): ClusterWorkerHistoryEntry[] {
  const cutoff = now - days * DAY;
  return history
    .filter((entry) => entry.exitedAt !== undefined && entry.exitedAt >= cutoff)
    .sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0));
}

export function workerTaskId(entry: ClusterWorkerRegistration): string | undefined {
  return entry.resolvedTaskId ?? entry.currentTaskId ?? entry.lastBoundTaskId;
}

/** Worker lists joined by `workerId`; the first list wins, so a live registration outranks its history. */
export function mergeWorkers(...lists: ClusterWorkerRegistration[][]): ClusterWorkerRegistration[] {
  const byId = new Map<string, ClusterWorkerRegistration>();
  for (const list of lists) {
    for (const worker of list) {
      if (!byId.has(worker.workerId)) {
        byId.set(worker.workerId, worker);
      }
    }
  }
  return [...byId.values()];
}

export interface WorkerRunFacts {
  run?: Run;
  startedAt: number;
  endedAt?: number;
}

/** The run a worker served, if it is loaded; otherwise the worker's own spawn and exit times. */
export function workerRunFacts(entry: ClusterWorkerRegistration, runs: Run[]): WorkerRunFacts {
  const taskId = workerTaskId(entry);
  return {
    run: taskId === undefined ? undefined : runs.find((r) => r.task.id === taskId),
    startedAt: entry.spawnedAt ?? entry.stats.registeredAt,
    endedAt: entry.exitedAt,
  };
}
