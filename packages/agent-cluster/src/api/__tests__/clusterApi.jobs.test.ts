import { describe, expect, test } from 'bun:test';
import type { ClusterJobWithDetail } from '@qqbot/api-types';
import type { ClusterManager } from '../../cluster/ClusterManager';
import type { JobRecord, TaskRecord } from '../../cluster/types';
import type { ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import { ClusterApi } from '../clusterApi';

const OLD_JOB = {
  id: 'job-old',
  project: 'demo',
  description: 'three weeks ago',
  status: 'completed',
  createdAt: '2026-10-20T08:00:00.000Z',
  taskCount: 1,
  tasksCompleted: 1,
  tasksFailed: 0,
  planning: 'auto',
} as JobRecord;

const OLD_TASK = {
  id: 'task-old',
  jobId: 'job-old',
  project: 'demo',
  description: 'three weeks ago',
  status: 'failed',
  source: 'queue',
  createdAt: '2026-10-20T08:00:00.000Z',
} as TaskRecord;

describe('GET /api/cluster/jobs/:id', () => {
  test('reads a job the in-memory window no longer holds from the database', async () => {
    const cluster = {
      isStarted: () => true,
      getScheduler: () => ({
        getJob: () => undefined,
        resolveJob: (id: string) => (id === OLD_JOB.id ? OLD_JOB : undefined),
        getJobTasks: () => [OLD_TASK],
        routeMessage: () => ({ kind: 'resume' }),
        retryBlocker: () => null,
        forkBlocker: () => 'No session id was recorded for this task',
      }),
      getHub: () => ({ workerRegistry: { getWorkersByJobId: () => [] } }),
    };
    const api = new ClusterApi(cluster as unknown as ClusterManager, {} as ProjectRegistry);
    const path = '/api/cluster/jobs/job-old';
    const response = await api.handle(path, new Request(`http://hub${path}`));
    expect(response?.status).toBe(200);
    const job = (await response?.json()) as ClusterJobWithDetail;
    expect(job.tasks.map((t) => t.id)).toEqual(['task-old']);
    expect(job.tasks[0].retry).toEqual({ ok: true });
    expect(job.tasks[0].fork).toEqual({ ok: false, reason: 'No session id was recorded for this task' });
  });
});
