import { expect, test } from 'bun:test';
import type { ClusterTask } from '@qqbot/api-types';
import { buildRuns } from './runs';
import { elapsedFraction, workerState } from './topology';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function task(id: string, patch: Partial<ClusterTask> = {}): ClusterTask {
  return {
    id,
    jobId: 'j1',
    project: 'demo',
    description: id,
    status: 'running',
    source: 'queue',
    createdAt: '2026-11-04T11:00:00Z',
    ...patch,
  };
}

test('elapsedFraction is a capped share of half an hour', () => {
  expect(elapsedFraction(0)).toBe(0);
  expect(elapsedFraction(15 * 60_000)).toBe(0.5);
  expect(elapsedFraction(2 * 60 * 60_000)).toBe(1);
  expect(elapsedFraction(-5)).toBe(0);
});

test('workerState follows the run it serves', () => {
  expect(workerState(undefined)).toBe('idle');
  const [run] = buildRuns([{ task: task('r') }], [], [], NOW);
  expect(workerState(run)).toBe('working');
  expect(workerState({ ...run, stage: 'asking' })).toBe('asking');
  expect(workerState({ ...run, stage: 'blocked' })).toBe('failed');
  expect(workerState({ ...run, stage: 'done' })).toBe('exited');
});
