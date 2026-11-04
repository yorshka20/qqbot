import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClusterTaskDetail, ClusterTaskOutputResponse } from '@qqbot/api-types';
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
      routeMessage: () => ({ kind: 'refused', reason: 'stub' }),
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

describe('GET /api/cluster/tasks/:id/output', () => {
  function apiReading(logPath: string | undefined): ClusterApi {
    const cluster = {
      isStarted: () => true,
      getScheduler: () => ({ findTask: (id: string) => ({ id, logPath }) }),
    };
    return new ClusterApi(cluster as unknown as ClusterManager, {} as ProjectRegistry);
  }

  async function output(api: ClusterApi): Promise<ClusterTaskOutputResponse> {
    const path = '/api/cluster/tasks/task-b/output';
    const response = await api.handle(path, new Request(`http://hub${path}`));
    return (await response?.json()) as ClusterTaskOutputResponse;
  }

  test('reads the worker log after the worker is gone, and only its end when it is long', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-output-'));
    const log = join(dir, 'out.log');
    writeFileSync(log, 'short log');
    expect(await output(apiReading(log))).toEqual({ output: 'short log', truncated: false });

    writeFileSync(log, `start${'x'.repeat(300 * 1024)}end`);
    const long = await output(apiReading(log));
    expect(long.truncated).toBe(true);
    expect(long.output.endsWith('end')).toBe(true);
    expect(long.output.startsWith('start')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('is empty for a task with no log', async () => {
    expect(await output(apiReading(undefined))).toEqual({ output: '', truncated: false });
  });
});
