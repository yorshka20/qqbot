import type { ClusterJob, ClusterJobWithDetail } from '@qqbot/api-types';
import { isLive } from './stage';

/** The listed fields that identify which run of a job it is: an owner-resumed job ends again with a new `completedAt`. */
export type ListedJob = Pick<ClusterJob, 'id' | 'status' | 'completedAt'>;

export interface CachedJobDetail {
  detail: ClusterJobWithDetail | null;
  /** The listed job's `completedAt` when this detail was read. */
  completedAt?: string;
}

function isTerminalJobStatus(status: ClusterJob['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Read a job's detail through `cache`. A finished job is read once, but a job the owner resumed is
 * listed running again and must be read anew, so an entry only answers for the run it was read for.
 */
export async function loadJobDetail(
  cache: Map<string, CachedJobDetail>,
  listed: ListedJob,
  read: (jobId: string) => Promise<ClusterJobWithDetail | null>,
): Promise<ClusterJobWithDetail | null> {
  const cached = cache.get(listed.id);
  if (cached !== undefined && isTerminalJobStatus(listed.status) && cached.completedAt === listed.completedAt) {
    return cached.detail;
  }
  // The scheduler keeps a week of jobs in memory; an older one 404s and has no task rows left to show.
  const detail = await read(listed.id);
  // A job ends with its root task; a planner's children can outlive it and still change.
  if (isTerminalJobStatus(listed.status) && !detail?.tasks.some(isLive)) {
    cache.set(listed.id, { detail, completedAt: listed.completedAt });
  } else {
    cache.delete(listed.id);
  }
  return detail;
}
