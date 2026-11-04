import { describe, expect, test } from 'bun:test';
import type { ClusterStatusResponse, ClusterTemplatesResponse } from '@qqbot/api-types';
import { daemonSummary } from './daemon';
import { busyWorkers, spareSlots } from './slots';

const status = (started: boolean, paused: boolean, workers: Array<{ template: string }> = []) =>
  ({ started, status: { paused, workers, maxConcurrentWorkers: 4 } }) as unknown as ClusterStatusResponse;
const templates = {
  templates: [
    { name: 'a', maxConcurrent: 2 },
    { name: 'b', maxConcurrent: 3 },
  ],
  projectDefaults: {},
} as unknown as ClusterTemplatesResponse;

describe('daemonSummary', () => {
  test('not loaded yet', () => {
    expect(daemonSummary(null, false, false)).toMatchObject({ tone: 'muted', running: 0, capacity: 0 });
  });
  test('unreachable', () => {
    expect(daemonSummary(null, true, true).tone).toBe('failed');
  });
  test('stopped', () => {
    expect(daemonSummary(status(false, false), false, true)).toMatchObject({
      tone: 'attention',
      label: '调度已停止',
    });
  });
  test('paused', () => {
    expect(daemonSummary(status(true, true), false, true).label).toBe('调度已暂停');
  });
  test('running is the live workers and capacity the cluster-wide cap', () => {
    expect(daemonSummary(status(true, false, [{ template: 'a' }]), false, true)).toEqual({
      tone: 'done',
      label: '调度运行中',
      running: 1,
      capacity: 4,
    });
  });
});

describe('spareSlots', () => {
  test('is bounded by the cluster-wide cap, not the sum of the templates', () => {
    expect(spareSlots(status(true, false), templates)).toBe(4);
  });
  test('is bounded by what the templates have left', () => {
    const busy = status(true, false, [{ template: 'a' }, { template: 'a' }, { template: 'b' }]);
    expect(busyWorkers(busy, 'a')).toBe(2);
    expect(spareSlots(busy, templates)).toBe(1);
  });
});
