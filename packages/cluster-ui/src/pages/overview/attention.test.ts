import { describe, expect, test } from 'bun:test';
import type { ClusterJob, ClusterTask } from '@qqbot/api-types';
import { classifyTasks, isRecentJob, RECENT_WINDOW_MS } from './attention';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');

function job(overrides: Partial<ClusterJob> = {}): ClusterJob {
  return {
    id: 'job-1',
    project: 'demo',
    description: 'demo job',
    status: 'completed',
    createdAt: new Date(NOW - 60_000).toISOString(),
    completedAt: new Date(NOW - 30_000).toISOString(),
    taskCount: 1,
    tasksCompleted: 1,
    tasksFailed: 0,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<ClusterTask> = {}): ClusterTask {
  return {
    id,
    jobId: 'job-1',
    project: 'demo',
    description: 'demo task',
    status: 'completed',
    source: 'queue',
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

describe('isRecentJob', () => {
  test('a terminal job leaves the window 24h after it completed', () => {
    const inside = new Date(NOW - RECENT_WINDOW_MS + 1000).toISOString();
    const outside = new Date(NOW - RECENT_WINDOW_MS - 1000).toISOString();
    expect(isRecentJob(job({ completedAt: inside }), NOW)).toBe(true);
    expect(isRecentJob(job({ completedAt: outside }), NOW)).toBe(false);
  });

  test('a live job counts however old it is', () => {
    const old = new Date(NOW - 10 * RECENT_WINDOW_MS).toISOString();
    expect(isRecentJob(job({ status: 'running', createdAt: old, completedAt: undefined }), NOW)).toBe(true);
  });
});

describe('classifyTasks', () => {
  test('blocked and failed need action, a completed root is a result to read', () => {
    const j = job();
    const { stuck, finished } = classifyTasks([
      { job: j, task: task('blocked', { status: 'blocked' }) },
      { job: j, task: task('failed', { status: 'failed' }) },
      { job: j, task: task('done') },
    ]);
    expect(stuck.map((t) => t.task.id).sort()).toEqual(['blocked', 'failed']);
    expect(finished.map((t) => t.task.id)).toEqual(['done']);
  });

  test('a completed child is not a separate result, a failed child is still stuck', () => {
    const j = job();
    const { stuck, finished } = classifyTasks([
      { job: j, task: task('root') },
      { job: j, task: task('child-ok', { parentTaskId: 'root' }) },
      { job: j, task: task('child-bad', { parentTaskId: 'root', status: 'failed' }) },
    ]);
    expect(finished.map((t) => t.task.id)).toEqual(['root']);
    expect(stuck.map((t) => t.task.id)).toEqual(['child-bad']);
  });

  test('cancelled and live tasks need nothing', () => {
    const j = job();
    const { stuck, finished } = classifyTasks([
      { job: j, task: task('cancelled', { status: 'cancelled' }) },
      { job: j, task: task('running', { status: 'running' }) },
    ]);
    expect(stuck).toEqual([]);
    expect(finished).toEqual([]);
  });
});
