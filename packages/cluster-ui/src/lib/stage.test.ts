import { describe, expect, test } from 'bun:test';
import type { ClusterTask } from '@qqbot/api-types';
import { REVIEW_WINDOW_MS, stageOf, stageOfStatus, stageRank } from './stage';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function task(patch: Partial<ClusterTask>): ClusterTask {
  return {
    id: 't1',
    jobId: 'j1',
    project: 'demo',
    description: '做一件事',
    status: 'running',
    source: 'queue',
    createdAt: '2026-11-04T11:00:00Z',
    ...patch,
  };
}

const quiet = { asking: false, seen: false, now: NOW };

describe('stageOf', () => {
  test('a pending question outranks running', () => {
    expect(stageOf(task({}), { ...quiet, asking: true })).toBe('asking');
    expect(stageOf(task({}), quiet)).toBe('running');
  });

  test('pending and claimed are both queued', () => {
    expect(stageOf(task({ status: 'pending' }), quiet)).toBe('queued');
    expect(stageOf(task({ status: 'claimed' }), quiet)).toBe('queued');
  });

  test('failed and blocked stay themselves whether seen or not', () => {
    expect(stageOf(task({ status: 'failed' }), { ...quiet, seen: true })).toBe('failed');
    expect(stageOf(task({ status: 'blocked' }), quiet)).toBe('blocked');
  });

  test('a completed run waits for review until seen', () => {
    const completed = task({ status: 'completed', completedAt: '2026-11-04T11:30:00Z' });
    expect(stageOf(completed, quiet)).toBe('review');
    expect(stageOf(completed, { ...quiet, seen: true })).toBe('done');
  });

  test('a completed run stops asking for review after the window', () => {
    const old = new Date(NOW - REVIEW_WINDOW_MS - 1000).toISOString();
    expect(stageOf(task({ status: 'completed', completedAt: old }), quiet)).toBe('done');
  });

  test('cancelled needs nothing from anyone', () => {
    expect(stageOf(task({ status: 'cancelled' }), quiet)).toBe('cancelled');
  });
});

test('the order is needs-you, running, waiting, ended', () => {
  const rank = ['asking', 'review', 'running', 'queued', 'done'] as const;
  const ranks = rank.map(stageRank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(new Set(ranks).size).toBe(rank.length);
});

describe('stageOfStatus', () => {
  test('maps every task status to a stage', () => {
    expect(stageOfStatus('pending')).toBe('queued');
    expect(stageOfStatus('claimed')).toBe('queued');
    expect(stageOfStatus('running')).toBe('running');
    expect(stageOfStatus('completed')).toBe('done');
    expect(stageOfStatus('failed')).toBe('failed');
    expect(stageOfStatus('blocked')).toBe('blocked');
    expect(stageOfStatus('cancelled')).toBe('cancelled');
  });
});
