import { describe, expect, test } from 'bun:test';
import type { ClusterHelpRequest, ClusterTask } from '@qqbot/api-types';
import { buildInbox } from './inbox';
import { buildRuns, parseFiles, runTitle, sortRuns } from './runs';

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
    const runs = buildRuns(rows, [ask('a1', 'asking')], [], new Set(), NOW);
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

describe('buildInbox', () => {
  const failed = task('f', { status: 'failed', completedAt: '2026-11-04T11:40:00Z' });
  const finished = task('c', { status: 'completed', completedAt: '2026-11-04T11:45:00Z' });

  function inbox(rows: ClusterTask[], help: ClusterHelpRequest[], seen: string[], open: string | null = null) {
    const seenSet = new Set(seen);
    const runs = buildRuns(
      rows.map((t) => ({ task: t })),
      help,
      [],
      seenSet,
      NOW,
    );
    return buildInbox(runs, help, seenSet, open);
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
