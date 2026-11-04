import { describe, expect, test } from 'bun:test';
import type { ClusterEventEntry, ClusterEventType, ClusterTask } from '@qqbot/api-types';
import { buildTimeline, foldTimeline, reportStats, rulerGap, rulerMinutesLabel, type TimelineNode } from './timeline';

const T0 = Date.parse('2026-11-04T12:00:00Z');
const MIN = 60_000;

function task(patch: Partial<ClusterTask> = {}): ClusterTask {
  return {
    id: 't1',
    jobId: 'j1',
    project: 'demo',
    description: '做一件事',
    status: 'running',
    source: 'queue',
    createdAt: new Date(T0).toISOString(),
    workerId: 'worker-1',
    workerPid: 4242,
    workerStartedAt: new Date(T0 + MIN).toISOString(),
    ...patch,
  };
}

let seq = 0;
function event(type: ClusterEventType, minute: number, data: Record<string, unknown> = {}): ClusterEventEntry {
  seq += 1;
  const timestamp = T0 + minute * MIN;
  return { seq, timestamp, createdAt: new Date(timestamp).toISOString(), type, sourceWorkerId: 'worker-1', data };
}

const base = { help: [], answers: new Map<string, string>() };

describe('rulerGap', () => {
  test('a gap under a minute draws nothing', () => {
    expect(rulerGap(T0, T0 + 59_000)).toEqual({ ticks: 0, foldedMinutes: null });
  });

  test('one tick per whole minute, up to ten', () => {
    expect(rulerGap(T0, T0 + 3.5 * MIN)).toEqual({ ticks: 3, foldedMinutes: null });
    expect(rulerGap(T0, T0 + 10 * MIN)).toEqual({ ticks: 10, foldedMinutes: null });
  });

  test('past ten minutes the gap folds', () => {
    expect(rulerGap(T0, T0 + 23 * MIN)).toEqual({ ticks: 0, foldedMinutes: 23 });
  });

  test('clock skew never draws a negative gap', () => {
    expect(rulerGap(T0, T0 - MIN)).toEqual({ ticks: 0, foldedMinutes: null });
  });
});

describe('rulerMinutesLabel', () => {
  test('reads a tick count back as a minute label', () => {
    expect(rulerMinutesLabel(3)).toBe('3 分钟');
  });
});

describe('buildTimeline', () => {
  test('orders record and events into one stream, whatever order the route returned', () => {
    const events = [event('task_completed', 5, { summary: '好了' }), event('worker_progress', 2, { summary: '进行中' })];
    const nodes = buildTimeline({
      ...base,
      task: task({ status: 'completed', completedAt: new Date(T0 + 5 * MIN).toISOString() }),
      events,
    });
    expect(nodes.map((n) => n.kind)).toEqual(['note', 'note', 'progress', 'end']);
    expect(nodes[1]).toMatchObject({ text: '启动 worker-1 · pid 4242' });
  });

  test('a lock folds into the preceding progress node', () => {
    const nodes = buildTimeline({
      ...base,
      task: task(),
      events: [event('worker_progress', 2, { summary: '改' }), event('lock_acquired', 3, { files: ['a', 'b', 'c'] })],
    });
    expect(nodes.filter((n) => n.kind === 'progress')).toMatchObject([{ lockedFiles: 3 }]);
    expect(nodes).toHaveLength(3);
  });

  test('a lock before any progress waits for the next one', () => {
    const nodes = buildTimeline({
      ...base,
      task: task(),
      events: [event('lock_acquired', 2, { files: ['a'] }), event('worker_progress', 3, { summary: '改' })],
    });
    expect(nodes.find((n) => n.kind === 'progress')).toMatchObject({ lockedFiles: 1 });
  });

  test('a pending question carries the options the event lacks', () => {
    const nodes = buildTimeline({
      ...base,
      help: [
        {
          id: 'a1',
          workerId: 'worker-1',
          type: 'decision',
          question: '选哪个？',
          options: ['A', 'B'],
          status: 'pending',
          createdAt: new Date(T0).toISOString(),
        },
      ],
      task: task(),
      events: [event('help_request', 2, { askId: 'a1', question: '选哪个？' })],
    });
    expect(nodes.find((n) => n.kind === 'question')).toMatchObject({ pending: true, options: ['A', 'B'] });
  });

  test('a question no longer pending is answered, with the text this browser remembers', () => {
    const nodes = buildTimeline({
      ...base,
      answers: new Map([['a1', '方案 A']]),
      task: task(),
      events: [event('help_request', 2, { askId: 'a1', question: '选哪个？' })],
    });
    expect(nodes.find((n) => n.kind === 'question')).toMatchObject({ pending: false, answer: '方案 A' });
  });

  test('a kill leaves no task event, the record still ends the stream', () => {
    const nodes = buildTimeline({
      ...base,
      task: task({ status: 'cancelled', completedAt: new Date(T0 + 4 * MIN).toISOString(), error: '手动终止' }),
      events: [],
    });
    expect(nodes.at(-1)).toMatchObject({ kind: 'end', state: 'cancelled', summary: '手动终止' });
  });
});

describe('reportStats', () => {
  test('keeps every number a report carried', () => {
    expect(reportStats({ linesAdded: 12, linesRemoved: 3, testsRan: 10, testsPassed: 9 })).toEqual({
      linesAdded: 12,
      linesRemoved: 3,
      testsRan: 10,
      testsPassed: 9,
    });
  });

  test('a report with no numbers has no stats', () => {
    expect(reportStats(undefined)).toBeUndefined();
    expect(reportStats({ error: '挂了', blockReason: '缺凭据' })).toBeUndefined();
  });

  test('only the numbers present are kept', () => {
    expect(reportStats({ testsRan: 4 })).toEqual({ testsRan: 4 });
  });
});

describe('progress report fields', () => {
  test('a progress node carries the files and numbers of its report', () => {
    const nodes = buildTimeline({
      ...base,
      task: task(),
      events: [
        event('worker_progress', 2, {
          summary: '改完了',
          filesModified: ['src/a.ts', 'src/b.ts'],
          detail: { linesAdded: 5 },
        }),
      ],
    });
    expect(nodes.find((n) => n.kind === 'progress')).toMatchObject({
      files: ['src/a.ts', 'src/b.ts'],
      stats: { linesAdded: 5 },
    });
  });
});

describe('foldTimeline', () => {
  const note = (i: number): TimelineNode => ({ kind: 'note', id: `n${i}`, at: T0 + i, text: String(i) });

  test('a short stream folds nothing', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => note(i));
    expect(foldTimeline(nodes).every((item) => !item.fold)).toBe(true);
  });

  test('the middle of a long stream folds into one row', () => {
    const items = foldTimeline(Array.from({ length: 40 }, (_, i) => note(i)));
    const folds = items.filter((item) => item.fold);
    expect(folds).toHaveLength(1);
    expect(folds[0].fold && folds[0].nodes).toHaveLength(18);
    expect(items).toHaveLength(23);
  });

  test('a waiting question survives the fold', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => note(i));
    nodes[10] = { kind: 'question', id: 'q', at: T0 + 10, askId: 'a', question: '？', pending: true };
    const items = foldTimeline(nodes);
    expect(items.some((item) => !item.fold && item.node.id === 'q')).toBe(true);
    expect(items.filter((item) => item.fold)).toHaveLength(2);
  });

  test('progress reports are never folded away', () => {
    const nodes: TimelineNode[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'progress',
      id: `p${i}`,
      at: T0 + i,
      summary: String(i),
      files: [],
      lockedFiles: 0,
    }));
    const items = foldTimeline(nodes);
    expect(items).toHaveLength(30);
    expect(items.every((item) => !item.fold)).toBe(true);
  });

  test('a fold carries exactly the nodes it hides', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => note(i));
    const folds = foldTimeline(nodes).filter((item) => item.fold);
    expect(folds).toHaveLength(1);
    expect(folds[0].fold && folds[0].nodes.map((n) => n.id)).toEqual(nodes.slice(2, 10).map((n) => n.id));
  });
});
