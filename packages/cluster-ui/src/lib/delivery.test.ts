import { describe, expect, test } from 'bun:test';
import type { ClusterJob, ClusterTask } from '@qqbot/api-types';
import { deliveryOf } from './delivery';

const task = (patch: Partial<ClusterTask> = {}) =>
  ({ id: 't', jobId: 'j', status: 'completed', ...patch }) as unknown as ClusterTask;
const job = (patch: Partial<ClusterJob> = {}) =>
  ({ id: 'j', integrationBranch: 'cluster/j', baseBranch: 'master', ...patch }) as unknown as ClusterJob;

describe('deliveryOf', () => {
  test('a run with no branch has nothing to say', () => {
    expect(deliveryOf(undefined, task())).toBeNull();
    expect(deliveryOf(job({ integrationBranch: undefined }), task())).toBeNull();
  });

  test('a landed job names the base branch', () => {
    expect(deliveryOf(job({ landedAt: '2026-11-04T10:00:00Z' }), task())).toMatchObject({
      tone: 'done',
      label: '已合入 master',
      canLand: false,
    });
  });

  test('a failed landing shows why and can run again', () => {
    expect(deliveryOf(job({ landError: 'conflict in a.txt' }), task({ status: 'blocked' }))).toMatchObject({
      tone: 'failed',
      detail: 'conflict in a.txt',
      canLand: true,
    });
  });

  test('a running job says where it will land', () => {
    expect(deliveryOf(job(), task({ status: 'running' }))?.label).toContain('合入 master');
  });

  test('a job with no changes completes with nothing to land', () => {
    expect(deliveryOf(job(), task())).toMatchObject({ label: '没有改动要合入', canLand: false });
  });

  test('a job from before landing can still land', () => {
    expect(deliveryOf(job({ baseBranch: undefined }), task())).toMatchObject({ tone: 'attention', canLand: true });
  });

  test('a failed root task does not offer to land', () => {
    expect(deliveryOf(job(), task({ status: 'failed' }))).toMatchObject({ tone: 'muted', canLand: false });
  });

  test('a child reports the integration branch, never the base branch', () => {
    const child = { parentTaskId: 'root', branch: 'cluster/j-c' };
    expect(deliveryOf(job(), task({ ...child, mergedAt: '2026-11-04T10:00:00Z' }))?.label).toBe('已合入 cluster/j');
    expect(deliveryOf(job(), task({ ...child, status: 'running' }))?.label).toBe('工作在 cluster/j-c');
    expect(deliveryOf(job(), task({ ...child, status: 'failed' }))?.label).toBe('没有合入 cluster/j');
  });
});
