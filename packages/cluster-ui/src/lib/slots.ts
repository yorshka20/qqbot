import type { ClusterStatusResponse, ClusterTemplatesResponse } from '@qqbot/api-types';

/** The daemon's own list of live workers: a worker that ended is not in it, however it ended. */
function liveWorkers(cluster: ClusterStatusResponse | null) {
  return cluster?.status.workers ?? [];
}

export function runningWorkers(cluster: ClusterStatusResponse | null): number {
  return liveWorkers(cluster).length;
}

export function busyWorkers(cluster: ClusterStatusResponse | null, template: string): number {
  return liveWorkers(cluster).filter((w) => w.template === template).length;
}

/** What can start now: bounded by the cluster-wide cap and by what the templates have left. */
export function spareSlots(cluster: ClusterStatusResponse | null, templates: ClusterTemplatesResponse | null): number {
  const headroom = (templates?.templates ?? []).reduce(
    (spare, t) => spare + Math.max(0, t.maxConcurrent - busyWorkers(cluster, t.name)),
    0,
  );
  return Math.min(headroom, Math.max(0, (cluster?.status.maxConcurrentWorkers ?? 0) - runningWorkers(cluster)));
}
