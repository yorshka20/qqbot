import type { ClusterTemplatesResponse, ClusterWorkerRegistration } from '@qqbot/api-types';

export function busyWorkers(workers: ClusterWorkerRegistration[], template: string): number {
  return workers.filter((w) => w.templateName === template && w.status !== 'exited').length;
}

/** Sum of each template's headroom. The daemon does not expose the cluster-wide cap, so this is an upper bound. */
export function spareSlots(templates: ClusterTemplatesResponse | null, workers: ClusterWorkerRegistration[]): number {
  return (templates?.templates ?? []).reduce(
    (spare, t) => spare + Math.max(0, t.maxConcurrent - busyWorkers(workers, t.name)),
    0,
  );
}
