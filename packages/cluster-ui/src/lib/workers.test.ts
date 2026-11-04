import { describe, expect, test } from 'bun:test';
import type { ClusterWorkerHistoryEntry } from '@qqbot/api-types';
import { exitedWorkers, workerResult, workerTaskId } from './workers';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function entry(patch: Partial<ClusterWorkerHistoryEntry> = {}): ClusterWorkerHistoryEntry {
  return {
    workerId: 'w1',
    role: 'coder',
    project: 'demo',
    templateName: 'demo-template',
    status: 'exited',
    lastSeen: NOW,
    syncCursor: 0,
    stats: { tasksCompleted: 0, tasksFailed: 0, totalReports: 0, registeredAt: NOW },
    ...patch,
  };
}

describe('workerResult', () => {
  test('reads the report status', () => {
    expect(workerResult(entry({ lastReportStatus: 'completed' }))).toEqual({ label: '已完成', tone: 'done' });
    expect(workerResult(entry({ lastReportStatus: 'failed' }))).toEqual({ label: '失败', tone: 'failed' });
    expect(workerResult(entry({ lastReportStatus: 'blocked' }))).toEqual({ label: '受阻', tone: 'failed' });
  });

  test('a worker with no terminal report is told apart by whether it exited', () => {
    expect(workerResult(entry({ lastReportStatus: 'working' }))).toEqual({ label: '进行中', tone: 'working' });
    expect(workerResult(entry({ lastReportStatus: 'working', exitedAt: NOW }))).toEqual({
      label: '已退出',
      tone: 'muted',
    });
    expect(workerResult(entry({}))).toEqual({ label: '进行中', tone: 'working' });
  });
});

describe('exitedWorkers', () => {
  test('keeps only exits inside the window, newest first', () => {
    const fresh = entry({ workerId: 'fresh', exitedAt: NOW - DAY });
    const older = entry({ workerId: 'older', exitedAt: NOW - 10 * DAY });
    const gone = entry({ workerId: 'gone' });
    expect(exitedWorkers([older, fresh, gone], NOW, 7).map((e) => e.workerId)).toEqual(['fresh']);
    expect(exitedWorkers([older, fresh, gone], NOW, 30).map((e) => e.workerId)).toEqual(['fresh', 'older']);
  });

  test('an exit exactly at the cutoff is inside it', () => {
    const boundary = entry({ exitedAt: NOW - 7 * DAY });
    expect(exitedWorkers([boundary], NOW, 7)).toHaveLength(1);
  });
});

describe('workerTaskId', () => {
  test('prefers the resolved task, then the current one, then the last bound', () => {
    expect(workerTaskId(entry({ resolvedTaskId: 'r', currentTaskId: 'c', lastBoundTaskId: 'l' }))).toBe('r');
    expect(workerTaskId(entry({ currentTaskId: 'c', lastBoundTaskId: 'l' }))).toBe('c');
    expect(workerTaskId(entry({ lastBoundTaskId: 'l' }))).toBe('l');
    expect(workerTaskId(entry({}))).toBeUndefined();
  });
});
