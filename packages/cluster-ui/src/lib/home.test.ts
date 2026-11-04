import { describe, expect, test } from 'bun:test';
import type { ClusterTask } from '@qqbot/api-types';
import { buildHome } from './home';
import type { Run } from './runs';
import type { Stage } from './stage';

const NOW = new Date(2026, 10, 4, 12, 0).getTime();

function run(id: string, stage: Stage, at: number): Run {
  const status: ClusterTask['status'] =
    stage === 'running' ? 'running' : stage === 'queued' ? 'pending' : stage === 'failed' ? 'failed' : 'completed';
  const live = status === 'running' || status === 'pending';
  const task: ClusterTask = {
    id,
    jobId: `job-${id}`,
    project: 'demo',
    description: id,
    status,
    source: 'api',
    createdAt: new Date(at).toISOString(),
    completedAt: live ? undefined : new Date(at).toISOString(),
    acknowledgedAt: stage === 'done' ? new Date(at).toISOString() : undefined,
  };
  return { task, stage, title: id, asks: [], since: at };
}

describe('buildHome', () => {
  test('totals count runs by stage and pass the spare slots through', () => {
    const runs = [run('a', 'running', NOW), run('b', 'running', NOW), run('c', 'queued', NOW)];
    const home = buildHome(runs, [], 3, NOW);
    expect(home.totals).toEqual({ running: 2, asking: 0, queued: 1, idle: 3 });
    expect(home.running.map((i) => i.root.task.id).sort()).toEqual(['a', 'b']);
  });

  test('attention is capped at five and the rest is counted', () => {
    const runs = Array.from({ length: 8 }, (_, i) => run(`f${i}`, 'failed', NOW - i * 60_000));
    const home = buildHome(runs, [], 0, NOW);
    expect(home.attention).toHaveLength(5);
    expect(home.moreAttention).toBe(3);
    expect(home.totals.asking).toBe(8);
  });

  test('attention at the limit has no remainder', () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(`f${i}`, 'failed', NOW - i * 60_000));
    expect(buildHome(runs, [], 0, NOW).moreAttention).toBe(0);
  });

  test('endedToday uses the local calendar day', () => {
    const runs = [
      run('today', 'done', new Date(2026, 10, 4, 0, 5).getTime()),
      run('yesterday', 'done', new Date(2026, 10, 3, 23, 55).getTime()),
    ];
    expect(buildHome(runs, [], 0, NOW).endedToday.map((i) => i.root.task.id)).toEqual(['today']);
  });
});
