import { describe, expect, test } from 'bun:test';
import type { ClusterJobWithDetail, ClusterTask } from '@qqbot/api-types';
import { type CachedJobDetail, loadJobDetail } from './jobCache';

function task(id: string, status: ClusterTask['status'] = 'completed', parentTaskId?: string): ClusterTask {
  return {
    id,
    jobId: 'job-1',
    project: 'demo',
    description: id,
    status,
    source: 'planner',
    createdAt: '2026-11-07T08:00:00.000Z',
    parentTaskId,
  } as ClusterTask;
}

function detail(completedAt: string | undefined, tasks: ClusterTask[]): ClusterJobWithDetail {
  return {
    id: 'job-1',
    project: 'demo',
    description: 'a planning run',
    status: completedAt === undefined ? 'running' : 'completed',
    createdAt: '2026-11-07T08:00:00.000Z',
    completedAt,
    taskCount: tasks.length,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasks,
  } as ClusterJobWithDetail;
}

const FINISHED_AT = '2026-11-07T09:00:00.000Z';
const RESUMED_AND_FINISHED_AT = '2026-11-07T10:00:00.000Z';

describe('loadJobDetail', () => {
  test('serves a finished job from the cache while the listed run is unchanged', async () => {
    const cache = new Map<string, CachedJobDetail>();
    const read = async () => detail(FINISHED_AT, [task('planner'), task('child-1', 'completed', 'planner')]);
    const listed = { id: 'job-1', status: 'completed' as const, completedAt: FINISHED_AT };

    const first = await loadJobDetail(cache, listed, read);
    const second = await loadJobDetail(cache, listed, read);

    expect(second).toBe(first);
    expect(cache.get('job-1')?.completedAt).toBe(FINISHED_AT);
  });

  test('refetches a resumed job, so a child spawned after the resume is shown', async () => {
    const cache = new Map<string, CachedJobDetail>();
    // Cached as finished before the owner resumed the planner.
    await loadJobDetail(
      cache,
      { id: 'job-1', status: 'completed', completedAt: FINISHED_AT },
      async () => detail(FINISHED_AT, [task('planner'), task('child-1', 'completed', 'planner')]),
    );

    const resumed = detail(undefined, [
      task('planner', 'running'),
      task('child-1', 'completed', 'planner'),
      task('child-2', 'completed', 'planner'),
    ]);
    const duringResume = await loadJobDetail(
      cache,
      { id: 'job-1', status: 'running', completedAt: undefined },
      async () => resumed,
    );
    expect(duringResume?.tasks.map((t) => t.id)).toContain('child-2');
    expect(cache.has('job-1')).toBe(false);

    const finishedAgain = await loadJobDetail(
      cache,
      { id: 'job-1', status: 'completed', completedAt: RESUMED_AND_FINISHED_AT },
      async () =>
        detail(RESUMED_AND_FINISHED_AT, [
          task('planner'),
          task('child-1', 'completed', 'planner'),
          task('child-2', 'completed', 'planner'),
        ]),
    );
    expect(finishedAgain?.tasks.map((t) => t.id)).toContain('child-2');
    expect(cache.get('job-1')?.completedAt).toBe(RESUMED_AND_FINISHED_AT);
  });

  test('does not cache a job whose children are still running', async () => {
    const cache = new Map<string, CachedJobDetail>();
    const detailWithLiveChild = detail(FINISHED_AT, [
      task('planner'),
      task('child-1', 'running', 'planner'),
    ]);
    await loadJobDetail(cache, { id: 'job-1', status: 'completed', completedAt: FINISHED_AT }, async () => detailWithLiveChild);
    expect(cache.has('job-1')).toBe(false);
  });

  test('reuses a cached 404 for the same finished run', async () => {
    const cache = new Map<string, CachedJobDetail>();
    const listed = { id: 'job-1', status: 'completed' as const, completedAt: FINISHED_AT };
    let reads = 0;
    const read = async () => {
      reads += 1;
      return null;
    };

    await loadJobDetail(cache, listed, read);
    await loadJobDetail(cache, listed, read);

    expect(reads).toBe(1);
    expect(cache.get('job-1')?.detail).toBeNull();
  });
});
