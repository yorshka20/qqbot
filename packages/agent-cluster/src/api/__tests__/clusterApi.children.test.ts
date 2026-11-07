import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClusterTaskDetail, ClusterTaskOutputResponse } from '@qqbot/api-types';
import type { ClusterManager } from '../../cluster/ClusterManager';
import type { TaskRecord } from '../../cluster/types';
import type { ProjectRegistry } from '../../codingAgent/ProjectRegistry';
import { ClusterApi } from '../clusterApi';

const ROOT_ID = 'planner-1';

function childTask(id: string): TaskRecord {
  return {
    id,
    jobId: 'job-1',
    project: 'demo',
    description: id,
    status: 'completed',
    source: 'planner',
    createdAt: '2026-11-07T08:00:00.000Z',
    parentTaskId: ROOT_ID,
  } as unknown as TaskRecord;
}

function apiWithChild(announced: unknown[], liveDependsOn: string[]): ClusterApi {
  const cluster = {
    isStarted: () => true,
    getScheduler: () => ({
      findTask: (id: string) => ({ id, jobId: 'job-1', status: 'running' }),
      getChildTasks: () => [childTask('child-1')],
      routeMessage: () => ({ kind: 'refused', reason: 'stub' }),
    }),
    getHub: () => ({
      eventLog: { query: () => announced },
      subscriptions: {
        of: () => ({ tasks: [], files: [], branch: false, dependsOn: liveDependsOn }),
      },
    }),
  };
  return new ClusterApi(cluster as unknown as ClusterManager, {} as ProjectRegistry);
}

async function taskDetail(api: ClusterApi): Promise<ClusterTaskDetail> {
  const path = `/api/cluster/tasks/${ROOT_ID}`;
  const response = await api.handle(path, new Request(`http://hub${path}`));
  return (await response?.json()) as ClusterTaskDetail;
}

describe('GET /api/cluster/tasks/:id children', () => {
  test('carries the plan dependencies of a child that already ended', async () => {
    // The child ended, so SubscriptionStore.dropTask removed its rows: only the event keeps them.
    const announced = [{ data: { subscriptions: { tasks: ['task-a'], files: [], branch: false, dependsOn: ['task-a'] } } }];
    const detail = await taskDetail(apiWithChild(announced, []));
    expect(detail.children?.[0]?.dependsOn).toEqual(['task-a']);
  });

  test('falls back to the live subscriptions of a child that is still running', async () => {
    const detail = await taskDetail(apiWithChild([], ['task-b']));
    expect(detail.children?.[0]?.dependsOn).toEqual(['task-b']);
  });

  test('reports no dependencies when it never had any', async () => {
    const announced = [{ data: { subscriptions: { tasks: [], files: ['src/**'], branch: false, dependsOn: [] } } }];
    const detail = await taskDetail(apiWithChild(announced, []));
    expect(detail.children?.[0]?.dependsOn).toEqual([]);
  });
});

describe('GET /api/cluster/tasks/:id/output?full=1', () => {
  function apiReading(logPath: string | undefined): ClusterApi {
    const cluster = {
      isStarted: () => true,
      getScheduler: () => ({ findTask: (id: string) => ({ id, logPath }) }),
    };
    return new ClusterApi(cluster as unknown as ClusterManager, {} as ProjectRegistry);
  }

  async function output(api: ClusterApi, search = ''): Promise<ClusterTaskOutputResponse> {
    const url = new URL(`http://hub/api/cluster/tasks/task-b/output${search}`);
    const response = await api.handle(url.pathname, new Request(url.toString()));
    return (await response?.json()) as ClusterTaskOutputResponse;
  }

  test('returns the whole log where the default route returns only its end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-output-full-'));
    const log = join(dir, 'out.log');
    const body = `start${'x'.repeat(600 * 1024)}end`;
    writeFileSync(log, body);

    const tail = await output(apiReading(log));
    expect(tail.truncated).toBe(true);
    expect(tail.output.length).toBe(256 * 1024);
    expect(tail.output.startsWith('start')).toBe(false);

    const full = await output(apiReading(log), '?full=1');
    expect(full.truncated).toBe(false);
    expect(full.output.length).toBe(body.length);
    expect(full.output.startsWith('start')).toBe(true);
    expect(full.output.endsWith('end')).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test('caps a log past 8 MiB at its last 8 MiB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-output-full-'));
    const log = join(dir, 'out.log');
    writeFileSync(log, `start${'y'.repeat(9 * 1024 * 1024)}end`);

    const full = await output(apiReading(log), '?full=1');
    expect(full.truncated).toBe(true);
    expect(full.output.length).toBe(8 * 1024 * 1024);
    expect(full.output.startsWith('start')).toBe(false);
    expect(full.output.endsWith('end')).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
