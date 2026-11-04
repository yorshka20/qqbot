import { describe, expect, test } from 'bun:test';
import type { ClusterTask } from '@qqbot/api-types';
import { buildRuns, type Run } from './runs';
import { inWindow, needsOlderHistory, RUN_WINDOW_LABEL, windowStart } from './window';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function run(patch: Partial<ClusterTask> = {}): Run {
  const task: ClusterTask = {
    id: 't1',
    jobId: 'j1',
    project: 'demo',
    description: '做一件事',
    status: 'running',
    source: 'queue',
    createdAt: new Date(NOW - 3 * DAY).toISOString(),
    ...patch,
  };
  return buildRuns([{ task }], [], [], NOW)[0];
}

describe('RUN_WINDOW_LABEL', () => {
  test('names each window', () => {
    expect(RUN_WINDOW_LABEL).toEqual({
      '24h': '最近 24 小时',
      '7d': '最近 7 天',
      all: '全部',
    });
  });
});

describe('windowStart', () => {
  test('counts back from now, and all reaches every run', () => {
    expect(windowStart('24h', NOW)).toBe(NOW - DAY);
    expect(windowStart('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(windowStart('all', NOW)).toBe(0);
  });
});

describe('inWindow', () => {
  test('a live run is always in the window', () => {
    expect(inWindow(run(), '24h', NOW)).toBe(true);
    expect(inWindow(run({ status: 'pending' }), '24h', NOW)).toBe(true);
  });

  test('a finished run is dated by its completion', () => {
    const finished = run({ status: 'completed', completedAt: new Date(NOW - HOUR).toISOString() });
    expect(inWindow(finished, '24h', NOW)).toBe(true);
    const old = run({ status: 'completed', completedAt: new Date(NOW - 2 * DAY).toISOString() });
    expect(inWindow(old, '24h', NOW)).toBe(false);
    expect(inWindow(old, '7d', NOW)).toBe(true);
    expect(inWindow(old, 'all', NOW)).toBe(true);
  });

  test('without a completion it falls back to when it was created', () => {
    const old = run({ status: 'cancelled' });
    expect(inWindow(old, '24h', NOW)).toBe(false);
    expect(inWindow(old, '7d', NOW)).toBe(true);
  });
});

describe('needsOlderHistory', () => {
  test('is false when nothing older exists', () => {
    expect(needsOlderHistory(NOW - DAY * 30, '7d', NOW, false)).toBe(false);
  });

  test('is true when the oldest loaded run is newer than the window start', () => {
    expect(needsOlderHistory(NOW - 2 * HOUR, '24h', NOW, true)).toBe(true);
    expect(needsOlderHistory(null, '24h', NOW, true)).toBe(true);
  });

  test('is false when history already reaches past the window start', () => {
    expect(needsOlderHistory(NOW - 2 * DAY, '24h', NOW, true)).toBe(false);
  });

  test('the all window keeps asking while more exists', () => {
    expect(needsOlderHistory(NOW - 30 * DAY, 'all', NOW, true)).toBe(true);
  });
});
