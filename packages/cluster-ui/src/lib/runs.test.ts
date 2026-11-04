import { describe, expect, test } from 'bun:test';
import type { ClusterHelpRequest, ClusterTask } from '@qqbot/api-types';
import { buildInbox } from './inbox';
import {
  buildRuns,
  composerDefaults,
  groupRunSections,
  needsPlannerTicket,
  orderRunsAsTree,
  parseFiles,
  plannerTicketDraft,
  runBody,
  runTimes,
  runTitle,
  sortRuns,
} from './runs';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function task(id: string, patch: Partial<ClusterTask> = {}): ClusterTask {
  return {
    id,
    jobId: `job-${id}`,
    project: 'demo',
    description: `运行 ${id}`,
    status: 'running',
    source: 'queue',
    createdAt: '2026-11-04T11:00:00Z',
    ...patch,
  };
}

function ask(id: string, taskId?: string): ClusterHelpRequest {
  return {
    id,
    workerId: 'w1',
    taskId,
    type: 'decision',
    question: '选哪个？',
    status: 'pending',
    createdAt: '2026-11-04T11:50:00Z',
  };
}

describe('runTitle', () => {
  test('takes the first non-empty line, without heading marks', () => {
    expect(runTitle('\n\n## 修卡片\n详情')).toBe('修卡片');
  });

  test('prefers the frontmatter title of a ticket run', () => {
    expect(runTitle('---\ntitle: 清理日志\nmaxChildren: 3\n---\n\n## 目标')).toBe('清理日志');
  });

  test('skips a frontmatter block with no title, even an empty one', () => {
    expect(runTitle('---\nmaxChildren: 3\n---\n\n正文')).toBe('正文');
    expect(runTitle('---\n---\n\n正文')).toBe('正文');
  });

  test('drops a leading task label after the heading mark', () => {
    expect(runTitle('# 任务：修复登录超时')).toBe('修复登录超时');
    expect(runTitle('Task: fix the retry loop')).toBe('fix the retry loop');
  });

  test('keeps the words of inline markdown and drops its marks', () => {
    expect(runTitle('**重构** `Shell.tsx`')).toBe('重构 Shell.tsx');
    expect(runTitle('- 读 [设计稿](https://example.com/a) 再动手')).toBe('读 设计稿 再动手');
    expect(runTitle('> 1. *先* 跑测试')).toBe('先 跑测试');
  });

  test('skips rules and blank lines down to the first line with words', () => {
    expect(runTitle('\n---\n===\n\n  \n整理文档\n其余')).toBe('整理文档');
  });

  test('a description of only marks has no title', () => {
    expect(runTitle('---\n***')).toBe('（无描述）');
  });
});

describe('runBody', () => {
  test('strips the frontmatter and keeps the body line breaks and marks', () => {
    expect(runBody('---\ntitle: 清理日志\n---\n\n## 目标\n- **删** 旧文件\n    缩进\n\n')).toBe(
      '## 目标\n- **删** 旧文件\n    缩进',
    );
  });

  test('without frontmatter it is the description with its tail trimmed', () => {
    const description = '  第一行\n\n第二行  \n\n';
    expect(runBody(description)).toBe(description.trimEnd());
  });

  test('a rule in the middle of the text is not frontmatter', () => {
    expect(runBody('说明\n---\n更多')).toBe('说明\n---\n更多');
  });
});

describe('parseFiles', () => {
  test('reads the JSON array the column holds, and keeps anything else whole', () => {
    expect(parseFiles('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts']);
    expect(parseFiles('a.ts')).toEqual(['a.ts']);
    expect(parseFiles(undefined)).toEqual([]);
  });
});

describe('sortRuns', () => {
  test('needs-you first, then running, queued, ended; ended newest first', () => {
    const rows = [
      task('done-old', { status: 'cancelled', completedAt: '2026-11-04T09:00:00Z' }),
      task('queued', { status: 'pending' }),
      task('running'),
      task('done-new', { status: 'cancelled', completedAt: '2026-11-04T11:00:00Z' }),
      task('failed', { status: 'failed', completedAt: '2026-11-04T10:00:00Z' }),
      task('asking'),
    ].map((t) => ({ task: t }));
    const runs = buildRuns(rows, [ask('a1', 'asking')], [], NOW);
    expect(sortRuns(runs).map((r) => r.task.id)).toEqual([
      'asking',
      'failed',
      'running',
      'queued',
      'done-new',
      'done-old',
    ]);
  });
});

describe('buildRuns', () => {
  test('a completed run with acknowledgedAt is done, not review', () => {
    const finished = task('c', { status: 'completed', completedAt: '2026-11-04T11:45:00Z' });
    const seen = { ...finished, acknowledgedAt: '2026-11-04T11:50:00Z' };
    const [unseen, acked] = buildRuns([{ task: finished }, { task: seen }], [], [], NOW);
    expect(unseen.stage).toBe('review');
    expect(acked.stage).toBe('done');
  });
});

describe('orderRunsAsTree', () => {
  const done = (id: string, patch: Partial<ClusterTask> = {}) =>
    task(id, { status: 'completed', completedAt: '2026-11-04T11:30:00Z', ...patch });

  const acknowledged = new Set(['p', 'p2', 'x', 'a', 'b', 'c', 'g', 'solo-old', 'solo-new']);
  const withAck = (t: ClusterTask): ClusterTask =>
    acknowledged.has(t.id) ? { ...t, acknowledgedAt: '2026-11-04T11:59:00Z' } : t;

  function tree(rows: ClusterTask[], help: ClusterHelpRequest[] = []) {
    return orderRunsAsTree(
      buildRuns(
        rows.map((t) => ({ task: withAck(t) })),
        help,
        [],
        NOW,
      ),
    );
  }

  test('without parent links the order is sortRuns and every depth is 0', () => {
    const rows = [
      done('solo-old', { completedAt: '2026-11-04T09:00:00Z' }),
      task('running'),
      done('solo-new', { completedAt: '2026-11-04T11:00:00Z' }),
    ];
    const rowsOut = tree(rows);
    const expected = sortRuns(buildRuns(rows.map((t) => ({ task: withAck(t) })), [], [], NOW));
    expect(rowsOut.map((r) => r.run.task.id)).toEqual(expected.map((r) => r.task.id));
    expect(rowsOut.every((r) => r.depth === 0 && !r.lastChild && r.childRuns === 0)).toBe(true);
  });

  test('a child follows its parent even when its own stage ranks earlier', () => {
    const out = tree([task('other', { status: 'pending' }), done('p'), task('a', { parentTaskId: 'p' })]);
    expect(out.map((r) => [r.run.task.id, r.depth])).toEqual([
      ['p', 0],
      ['a', 1],
      ['other', 0],
    ]);
    expect(out[0].childRuns).toBe(1);
  });

  test('a family with a question outranks a family that is all done', () => {
    const out = tree(
      [done('x'), done('p'), task('a', { parentTaskId: 'p' }), done('solo-new', { completedAt: '2026-11-04T11:59:00Z' })],
      [ask('a1', 'a')],
    );
    expect(out.map((r) => r.run.task.id)).toEqual(['p', 'a', 'solo-new', 'x']);
  });

  test('a parent outside the list makes its child a root', () => {
    const out = tree([task('a', { parentTaskId: 'filtered-out' })]);
    expect(out).toMatchObject([{ depth: 0, lastChild: false }]);
  });

  test('three levels nest, children in spawn order, the last sibling of each group closes its rail', () => {
    const out = tree([
      done('p'),
      task('b', { parentTaskId: 'p', createdAt: '2026-11-04T11:10:00Z' }),
      task('a', { parentTaskId: 'p', createdAt: '2026-11-04T11:05:00Z' }),
      task('g', { parentTaskId: 'a', createdAt: '2026-11-04T11:06:00Z' }),
    ]);
    expect(out.map((r) => [r.run.task.id, r.depth, r.lastChild])).toEqual([
      ['p', 0, false],
      ['a', 1, false],
      ['g', 2, true],
      ['b', 1, true],
    ]);
  });
});

describe('buildInbox', () => {
  const failed = task('f', { status: 'failed', completedAt: '2026-11-04T11:40:00Z' });
  const finished = task('c', { status: 'completed', completedAt: '2026-11-04T11:45:00Z' });

  function inbox(rows: ClusterTask[], help: ClusterHelpRequest[], seen: string[], open: string | null = null) {
    const runs = buildRuns(
      rows.map((t) => ({ task: seen.includes(t.id) ? { ...t, acknowledgedAt: '2026-11-04T11:59:00Z' } : t })),
      help,
      [],
      NOW,
    );
    return buildInbox(runs, help, open);
  }

  test('lists questions, then failures, then results to read', () => {
    const items = inbox([finished, failed, task('r')], [ask('a1', 'r')], []);
    expect(items.map((i) => i.kind)).toEqual(['ask', 'failed', 'review']);
  });

  test('one run with two questions is two rows', () => {
    expect(inbox([task('r')], [ask('a1', 'r'), ask('a2', 'r')], [])).toHaveLength(2);
  });

  test('a question from a worker with no task is still answerable', () => {
    expect(inbox([], [ask('a1')], []).map((i) => i.kind)).toEqual(['ask']);
  });

  test('a question of a run that already ended is dropped', () => {
    expect(inbox([failed], [ask('a1', 'f')], ['f'])).toHaveLength(0);
  });

  test('seen clears failures and results', () => {
    expect(inbox([failed, finished], [], ['f', 'c'])).toHaveLength(0);
  });

  test('the open run stays listed after being seen', () => {
    expect(inbox([finished], [], ['c'], 'c').map((i) => i.kind)).toEqual(['review']);
    expect(inbox([failed], [], ['f'], 'f').map((i) => i.kind)).toEqual(['failed']);
  });
});

describe('composerDefaults', () => {
  const projects = ['demo', 'other'];
  const projectDefaults = { demo: 'tpl-demo', other: 'tpl-other' };

  test('a remembered project that still exists keeps its remembered template', () => {
    expect(composerDefaults({ project: 'demo', template: 'tpl-x' }, projects, 'other', projectDefaults)).toEqual({
      project: 'demo',
      template: 'tpl-x',
    });
  });

  test('a remembered project that no longer exists falls back to the configured default', () => {
    expect(composerDefaults({ project: 'gone', template: 'tpl-x' }, projects, 'other', projectDefaults)).toEqual({
      project: 'other',
      template: 'tpl-other',
    });
  });

  test('nothing remembered and no default returns empty strings', () => {
    expect(composerDefaults({}, [], undefined, {})).toEqual({ project: '', template: '' });
  });
});

describe('groupRunSections', () => {
  const runsOf = (tasks: ClusterTask[], help: ClusterHelpRequest[] = []) =>
    buildRuns(tasks.map((t) => ({ task: t })), help, [], NOW);
  const seen = (t: ClusterTask): ClusterTask => ({ ...t, acknowledgedAt: '2026-11-04T11:59:00Z' });

  test('each stage lands in its section, and empty sections are not returned', () => {
    const runs = runsOf(
      [
        task('asking'),
        task('f', { status: 'failed', completedAt: '2026-11-04T11:30:00Z' }),
        task('run'),
        task('q', { status: 'pending' }),
        seen(task('done', { status: 'completed', completedAt: '2026-11-04T11:30:00Z' })),
        task('x', { status: 'cancelled', completedAt: '2026-11-04T11:30:00Z' }),
      ],
      [ask('a1', 'asking')],
    );
    const sections = groupRunSections(runs, { now: NOW, window: '24h' });
    expect(sections.map((s) => s.key)).toEqual(['attention', 'running', 'queued', 'ended']);
    expect(sections.map((s) => s.rows.map((r) => r.run.task.id))).toEqual([
      ['asking', 'f'],
      ['run'],
      ['q'],
      ['done', 'x'],
    ]);
  });

  test('a family stays together in the earliest section any member needs', () => {
    const parent = seen(task('p', { status: 'completed', completedAt: '2026-11-04T11:20:00Z' }));
    const [section] = groupRunSections(runsOf([parent, task('c', { parentTaskId: 'p' })]), {
      now: NOW,
      window: '24h',
    });
    expect(section.key).toBe('running');
    expect(section.rows.map((r) => [r.run.task.id, r.depth])).toEqual([
      ['p', 0],
      ['c', 1],
    ]);
  });

  test('a failed child pulls its finished parent into the attention section', () => {
    const parent = seen(task('p', { status: 'completed', completedAt: '2026-11-04T11:20:00Z' }));
    const child = task('c', { parentTaskId: 'p', status: 'failed', completedAt: '2026-11-04T11:30:00Z' });
    const [section] = groupRunSections(runsOf([parent, child]), { now: NOW, window: '24h' });
    expect(section.key).toBe('attention');
    expect(section.rows.map((r) => r.run.task.id)).toEqual(['p', 'c']);
  });

  test('a section that needs the owner is not bounded by the window', () => {
    const old = task('f', {
      status: 'failed',
      createdAt: '2026-10-01T10:00:00Z',
      completedAt: '2026-10-01T11:00:00Z',
    });
    expect(groupRunSections(runsOf([old]), { now: NOW, window: '24h' })).toMatchObject([{ key: 'attention' }]);
  });

  test('an ended family older than the window is dropped whole', () => {
    const parent = seen(task('p', { status: 'completed', completedAt: '2026-11-01T11:00:00Z', createdAt: '2026-11-01T10:00:00Z' }));
    const child = seen(
      task('c', {
        parentTaskId: 'p',
        status: 'completed',
        createdAt: '2026-11-01T10:05:00Z',
        completedAt: '2026-11-01T11:10:00Z',
      }),
    );
    expect(groupRunSections(runsOf([parent, child]), { now: NOW, window: '24h' })).toEqual([]);
    expect(groupRunSections(runsOf([parent, child]), { now: NOW, window: 'all' })).toHaveLength(1);
  });

  test('an ended family with one member inside the window is kept whole', () => {
    const parent = seen(task('p', { status: 'completed', completedAt: '2026-11-01T11:00:00Z', createdAt: '2026-11-01T10:00:00Z' }));
    const child = seen(task('c', { parentTaskId: 'p', status: 'completed', completedAt: '2026-11-04T11:30:00Z' }));
    const [section] = groupRunSections(runsOf([parent, child]), { now: NOW, window: '24h' });
    expect(section.key).toBe('ended');
    expect(section.rows.map((r) => r.run.task.id)).toEqual(['p', 'c']);
  });
});

describe('runTimes', () => {
  test('start is the worker start, end is completion, duration spans them', () => {
    const started = Date.parse('2026-11-04T11:00:00Z');
    const ended = Date.parse('2026-11-04T11:30:00Z');
    const t = task('t', {
      workerStartedAt: new Date(started).toISOString(),
      completedAt: new Date(ended).toISOString(),
    });
    expect(runTimes(t, undefined, NOW)).toEqual({ startedAt: started, endedAt: ended, durationMs: ended - started });
  });

  test('falls back to when the task started, then to the worker exit', () => {
    const started = Date.parse('2026-11-04T11:00:00Z');
    const exited = Date.parse('2026-11-04T11:20:00Z');
    expect(runTimes(task('t', { startedAt: new Date(started).toISOString() }), exited, NOW)).toEqual({
      startedAt: started,
      endedAt: exited,
      durationMs: exited - started,
    });
  });

  test('a run still going ends at now; one that never started has no duration', () => {
    const started = Date.parse('2026-11-04T11:00:00Z');
    expect(runTimes(task('t', { startedAt: new Date(started).toISOString() }), undefined, NOW)).toEqual({
      startedAt: started,
      endedAt: null,
      durationMs: NOW - started,
    });
    expect(runTimes(task('idle'), undefined, NOW)).toEqual({ startedAt: null, endedAt: null, durationMs: null });
  });
});

describe('needsPlannerTicket', () => {
  test('a planner with no ticket needs one; anything else does not', () => {
    expect(needsPlannerTicket('planner', undefined)).toBe(true);
    expect(needsPlannerTicket('planner', '')).toBe(true);
    expect(needsPlannerTicket('planner', 't1')).toBe(false);
    expect(needsPlannerTicket('executor', undefined)).toBe(false);
    expect(needsPlannerTicket(undefined, undefined)).toBe(false);
  });
});

describe('plannerTicketDraft', () => {
  test('makes a ready ticket titled after the description', () => {
    const description = '# 任务：修复登录超时\n\n详情';
    expect(plannerTicketDraft(description, 'demo', 'claude')).toEqual({
      title: '修复登录超时',
      status: 'ready',
      project: 'demo',
      template: 'claude',
      body: description,
    });
  });
});
