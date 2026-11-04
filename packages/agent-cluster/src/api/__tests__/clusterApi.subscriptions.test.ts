import { describe, expect, test } from 'bun:test';
import type { ClusterTaskDetail } from '@qqbot/api-types';
import type { ClusterManager } from '../../cluster/ClusterManager';
import type { HubSubscriptions } from '../../cluster/types';
import type { ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import { ClusterApi } from '../clusterApi';

function apiWith(subscriptions: HubSubscriptions): ClusterApi {
  const cluster = {
    isStarted: () => true,
    getScheduler: () => ({
      findTask: (id: string) => ({ id, jobId: 'job-1', status: 'running' }),
      getChildTasks: () => [],
    }),
    getHub: () => ({ subscriptions: { of: () => subscriptions } }),
  };
  return new ClusterApi(cluster as unknown as ClusterManager, {} as ProjectRegistry);
}

async function taskDetail(api: ClusterApi): Promise<ClusterTaskDetail> {
  const path = '/api/cluster/tasks/task-b';
  const response = await api.handle(path, new Request(`http://hub${path}`));
  return (await response?.json()) as ClusterTaskDetail;
}

describe('GET /api/cluster/tasks/:id', () => {
  test('carries the live subscriptions, dependencies included', async () => {
    const subscriptions = { tasks: ['task-a'], files: ['src/**'], branch: false, dependsOn: ['task-a'] };
    expect((await taskDetail(apiWith(subscriptions))).subscriptions).toEqual(subscriptions);
  });

  test('leaves the field out for a task that subscribed to nothing', async () => {
    const detail = await taskDetail(apiWith({ tasks: [], files: [], branch: false, dependsOn: [] }));
    expect(detail.subscriptions).toBeUndefined();
  });
});
