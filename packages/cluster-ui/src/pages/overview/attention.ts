import type { ClusterJob, ClusterTask } from '@qqbot/api-types';

export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface JobTask {
  task: ClusterTask;
  job: ClusterJob;
}

export interface TaskAttention {
  stuck: JobTask[];
  finished: JobTask[];
}

export function isTerminalJob(job: ClusterJob): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

/** A live job always counts: one of its tasks can have failed however long ago it started. */
export function isRecentJob(job: ClusterJob, now: number): boolean {
  if (!isTerminalJob(job)) {
    return true;
  }
  return now - new Date(job.completedAt ?? job.createdAt).getTime() < RECENT_WINDOW_MS;
}

function newestFirst(a: JobTask, b: JobTask): number {
  const at = (t: ClusterTask) => new Date(t.completedAt ?? t.createdAt).getTime();
  return at(b.task) - at(a.task);
}

/**
 * Sort tasks into what the owner has to act on. A finished job is one result to read, so
 * only its root task is listed; a failed child is listed on its own because the root can
 * still complete around it. Cancelled tasks were the owner's own decision and need nothing.
 */
export function classifyTasks(tasks: JobTask[]): TaskAttention {
  const stuck = tasks.filter(({ task }) => task.status === 'blocked' || task.status === 'failed');
  const finished = tasks.filter(({ task }) => task.status === 'completed' && !task.parentTaskId);
  return { stuck: stuck.sort(newestFirst), finished: finished.sort(newestFirst) };
}
