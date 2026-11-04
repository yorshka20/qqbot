import type { ClusterHelpRequest, ClusterTask } from '@qqbot/api-types';
import { describe, expect, test } from 'bun:test';
import { answersOf, buildInboxArchive, groupInboxByDay, type InboxItem } from './inbox';
import { buildRuns } from './runs';

const NOW = new Date(2026, 10, 4, 12, 0).getTime();

function askItem(key: string, since: number): InboxItem {
  const help: ClusterHelpRequest = {
    id: key,
    workerId: 'w1',
    type: 'decision',
    question: '选哪个？',
    status: 'pending',
    createdAt: new Date(since).toISOString(),
  };
  return { kind: 'ask', key, help, since };
}

describe('groupInboxByDay', () => {
  test('splits items across two days into two groups, oldest day first', () => {
    const groups = groupInboxByDay(
      [askItem('today', new Date(2026, 10, 4, 9, 0).getTime()), askItem('yesterday', new Date(2026, 10, 3, 9, 0).getTime())],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['昨天', '今天']);
    expect(groups.map((g) => g.items.map((i) => i.key))).toEqual([['yesterday'], ['today']]);
  });

  test('keeps multiple same-day items in one group, in the order given', () => {
    const groups = groupInboxByDay(
      [askItem('a', new Date(2026, 10, 4, 9, 0).getTime()), askItem('b', new Date(2026, 10, 4, 10, 0).getTime())],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.key)).toEqual(['a', 'b']);
  });

  test('an empty list groups to an empty list', () => {
    expect(groupInboxByDay([], NOW)).toEqual([]);
  });
});

function answered(id: string, taskId: string, answeredAt: string, answer = '选甲'): ClusterHelpRequest {
  return {
    id,
    workerId: 'w1',
    taskId,
    type: 'decision',
    question: '选哪个？',
    status: 'answered',
    answer,
    answeredBy: 'owner',
    createdAt: '2026-11-04T08:00:00Z',
    answeredAt,
  };
}

function runTask(id: string, patch: Partial<ClusterTask> = {}): ClusterTask {
  return {
    id,
    jobId: `job-${id}`,
    project: 'demo',
    description: `运行 ${id}`,
    status: 'failed',
    source: 'queue',
    createdAt: '2026-11-04T07:00:00Z',
    completedAt: '2026-11-04T08:00:00Z',
    ...patch,
  };
}

describe('answersOf', () => {
  test('an answered request contributes its answer', () => {
    const map = answersOf([answered('q1', 't1', '2026-11-04T09:00:00Z', '选乙')]);
    expect(map.get('q1')).toBe('选乙');
  });

  test('a pending request contributes nothing', () => {
    const pending: ClusterHelpRequest = { ...answered('q2', 't1', '2026-11-04T09:00:00Z'), status: 'pending', answer: undefined };
    expect(answersOf([pending]).size).toBe(0);
  });
});

describe('buildInboxArchive', () => {
  const NOW_MS = Date.parse('2026-11-04T12:00:00Z');
  const build = (tasks: ClusterTask[]) => buildRuns(tasks.map((task) => ({ task })), [], [], NOW_MS);

  test('an answered question lands in the archive with its answer and who answered', () => {
    const runs = build([runTask('t1', { status: 'running', completedAt: undefined })]);
    const [item] = buildInboxArchive(runs, [answered('q1', 't1', '2026-11-04T09:00:00Z', '选乙')]);
    expect(item.kind).toBe('answered');
    expect(item.help?.answer).toBe('选乙');
    expect(item.answeredBy).toBe('owner');
    expect(item.title).toBe('运行 t1');
    expect(item.taskId).toBe('t1');
    expect(item.at).toBe(Date.parse('2026-11-04T09:00:00Z'));
  });

  test('a failure that was acknowledged lands in the archive', () => {
    const runs = build([runTask('f1', { acknowledgedAt: '2026-11-04T10:00:00Z' })]);
    expect(buildInboxArchive(runs, []).map((i) => [i.kind, i.taskId])).toEqual([['failed', 'f1']]);
  });

  test('a cancelled run that was acknowledged lands in the archive as a seen failure', () => {
    const runs = build([runTask('x1', { status: 'cancelled', acknowledgedAt: '2026-11-04T10:00:00Z' })]);
    expect(buildInboxArchive(runs, []).map((i) => [i.kind, i.taskId])).toEqual([['failed', 'x1']]);
  });

  test('a finished run that was acknowledged lands in the archive as a seen result', () => {
    const runs = build([runTask('c1', { status: 'completed', acknowledgedAt: '2026-11-04T10:00:00Z' })]);
    expect(buildInboxArchive(runs, []).map((i) => i.kind)).toEqual(['review']);
  });

  test('what still waits on the owner stays out', () => {
    const runs = build([
      runTask('f2'),
      runTask('c2', { status: 'completed' }),
      runTask('t2', { status: 'running', completedAt: undefined }),
    ]);
    const pending: ClusterHelpRequest = { ...answered('q3', 't2', '2026-11-04T09:00:00Z'), status: 'pending', answer: undefined };
    expect(buildInboxArchive(runs, [pending])).toEqual([]);
  });

  test('a question whose run is not loaded anymore is kept, titled by the question', () => {
    const [item] = buildInboxArchive([], [answered('q4', 'gone', '2026-11-04T09:00:00Z')]);
    expect(item.kind).toBe('answered');
    expect(item.run).toBeUndefined();
    expect(item.taskId).toBe('gone');
    expect(item.title).toBe('选哪个？');
  });

  test('entries are ordered newest handled first', () => {
    const runs = build([
      runTask('f3', { acknowledgedAt: '2026-11-04T10:00:00Z' }),
      runTask('c3', { status: 'completed', acknowledgedAt: '2026-11-04T11:00:00Z' }),
      runTask('t3', { status: 'running', completedAt: undefined }),
    ]);
    const items = buildInboxArchive(runs, [answered('q5', 't3', '2026-11-04T10:30:00Z')]);
    expect(items.map((i) => i.id)).toEqual(['review:c3', 'answered:q5', 'failed:f3']);
  });
});
