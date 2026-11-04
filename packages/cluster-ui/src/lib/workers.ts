import type { ClusterWorkerHistoryEntry, ClusterWorkerRegistration } from '@qqbot/api-types';
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
