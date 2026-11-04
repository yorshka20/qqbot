import { describe, expect, test } from 'bun:test';
import type { ClusterStatusResponse, ClusterTemplatesResponse, ClusterWorkerRegistration } from '@qqbot/api-types';
import { daemonSummary } from './daemon';

const status = (started: boolean, paused: boolean) =>
  ({ started, status: { paused } }) as unknown as ClusterStatusResponse;
const templates = {
  templates: [
    { name: 'a', maxConcurrent: 2 },
    { name: 'b', maxConcurrent: 3 },
  ],
  projectDefaults: {},
} as unknown as ClusterTemplatesResponse;
const workers = [{ status: 'working' }, { status: 'exited' }] as unknown as ClusterWorkerRegistration[];

describe('daemonSummary', () => {
  test('not loaded yet', () => {
    expect(daemonSummary(null, false, false, [], null)).toMatchObject({ tone: 'muted', running: 0, capacity: 0 });
  });
  test('unreachable', () => {
    expect(daemonSummary(null, true, true, [], null).tone).toBe('failed');
  });
  test('stopped', () => {
    expect(daemonSummary(status(false, false), false, true, [], templates)).toMatchObject({
      tone: 'attention',
      label: '调度已停止',
    });
  });
  test('paused', () => {
    expect(daemonSummary(status(true, true), false, true, [], templates).label).toBe('调度已暂停');
  });
  test('running counts live workers and template capacity', () => {
    expect(daemonSummary(status(true, false), false, true, workers, templates)).toEqual({
      tone: 'done',
      label: '调度运行中',
      running: 1,
      capacity: 5,
    });
  });
});
