import { describe, expect, test } from 'bun:test';
import type { ClusterEventEntry, ClusterEventType, ClusterHelpRequest, ClusterTask } from '@qqbot/api-types';
import { buildConversation, type ConversationEntry, type ConversationInput } from './conversation';

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
    workerId: 'w1',
    workerPid: 4242,
    workerStartedAt: new Date(T0 + MIN).toISOString(),
    ...patch,
  };
}

let seq = 0;
function event(
  type: ClusterEventType,
  minute: number,
  data: Record<string, unknown> = {},
  sourceWorkerId = 'w1',
): ClusterEventEntry {
  seq += 1;
  const timestamp = T0 + minute * MIN;
  return { seq, timestamp, createdAt: new Date(timestamp).toISOString(), type, sourceWorkerId, data };
}

function request(id: string, patch: Partial<ClusterHelpRequest> = {}): ClusterHelpRequest {
  return {
    id,
    workerId: 'w1',
    type: 'decision',
    question: '选哪个？',
    status: 'pending',
    createdAt: new Date(T0 + 2 * MIN).toISOString(),
    ...patch,
  };
}

function conversation(input: Partial<ConversationInput> = {}): ConversationEntry[] {
  return buildConversation({ task: task(), events: [], help: [], helpHistory: [], ...input });
}

describe('buildConversation', () => {
  test('a directive is the owner speaking, with the text from data.text', () => {
    const entries = conversation({ events: [event('directive', 2, { text: '先停下' }, 'owner')] });
    expect(entries.find((entry) => entry.kind === 'owner')).toMatchObject({
      from: 'owner',
      text: '先停下',
      at: T0 + 2 * MIN,
    });
  });

  test('the stream interleaves by time: submitted, started, then the events', () => {
    const entries = conversation({
      events: [
        event('directive', 3, { text: '再改' }, 'owner'),
        event('worker_progress', 2, { summary: '改好了' }),
      ],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(['system', 'system', 'report', 'owner']);
  });

  test('two events at the same time keep the order they arrived in', () => {
    const entries = conversation({
      events: [event('directive', 2, { text: '甲' }, 'owner'), event('directive', 2, { text: '乙' }, 'owner')],
    });
    expect(entries.filter((entry) => entry.kind === 'owner').map((entry) => entry.text)).toEqual(['甲', '乙']);
  });

  test('a question carries the answer, the answerer and when', () => {
    const answeredAt = new Date(T0 + 5 * MIN).toISOString();
    const entries = conversation({
      events: [event('help_request', 2, { askId: 'a1', question: '选哪个？' })],
      helpHistory: [request('a1', { status: 'answered', answer: '选甲', answeredBy: 'owner', answeredAt })],
    });
    expect(entries.find((entry) => entry.kind === 'question')).toMatchObject({
      askId: 'a1',
      pending: false,
      answer: '选甲',
      answeredBy: 'owner',
      answeredAt: Date.parse(answeredAt),
    });
  });

  test('a pending question takes its text, context and options from the request', () => {
    const pending = request('a2', { question: '走哪条？', context: '两条都能到', options: ['甲', '乙'] });
    const entries = conversation({
      help: [pending],
      helpHistory: [pending],
      events: [event('help_request', 2, { askId: 'a2', question: '旧问题' })],
    });
    expect(entries.find((entry) => entry.kind === 'question')).toMatchObject({
      pending: true,
      question: '走哪条？',
      context: '两条都能到',
      options: ['甲', '乙'],
    });
  });

  test('without a history record the question text comes from the event', () => {
    const entries = conversation({
      events: [event('help_request', 2, { askId: 'a3', question: '事件里的问题' })],
    });
    expect(entries.find((entry) => entry.kind === 'question')).toMatchObject({
      question: '事件里的问题',
      pending: false,
    });
  });

  test('an answer whose help_request is outside the event window gets its own question row', () => {
    const entries = conversation({
      events: [event('answer', 4, { askId: 'a9', question: '走哪条？', answer: '甲' }, 'owner')],
    });
    const questions = entries.filter((entry) => entry.kind === 'question');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      askId: 'a9',
      pending: false,
      question: '走哪条？',
      answer: '甲',
      answeredBy: 'owner',
    });
  });

  test('an answer with its help_request already on the stream is not a second row', () => {
    const answeredAt = new Date(T0 + 5 * MIN).toISOString();
    const entries = conversation({
      events: [
        event('help_request', 2, { askId: 'a1', question: '选哪个？' }),
        event('answer', 5, { askId: 'a1', question: '选哪个？', answer: '甲' }, 'owner'),
      ],
      helpHistory: [request('a1', { status: 'answered', answer: '甲', answeredBy: 'owner', answeredAt })],
    });
    expect(entries.filter((entry) => entry.kind === 'question')).toHaveLength(1);
  });

  test('a cancelled run with no task event ends from the record', () => {
    const entries = conversation({
      task: task({
        status: 'cancelled',
        completedAt: new Date(T0 + 4 * MIN).toISOString(),
        error: '手动终止',
      }),
      events: [],
    });
    expect(entries.at(-1)).toMatchObject({ kind: 'end', state: 'cancelled', summary: '手动终止' });
  });

  test('the record end prefers the diff summary', () => {
    const entries = conversation({
      task: task({
        status: 'completed',
        completedAt: new Date(T0 + 4 * MIN).toISOString(),
        diffSummary: '改了 3 个文件',
        error: '旧错误',
      }),
      events: [],
    });
    expect(entries.at(-1)).toMatchObject({ kind: 'end', state: 'completed', summary: '改了 3 个文件' });
  });

  test('a task event ends the stream once, not twice', () => {
    const entries = conversation({
      task: task({ status: 'failed', completedAt: new Date(T0 + 5 * MIN).toISOString(), error: '记录' }),
      events: [event('task_failed', 4, { summary: '挂了', detail: { testsRan: 2, testsPassed: 1 } })],
    });
    const ends = entries.filter((entry) => entry.kind === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ state: 'failed', summary: '挂了', stats: { testsRan: 2, testsPassed: 1 } });
  });

  test('a progress report carries the files and numbers', () => {
    const entries = conversation({
      events: [
        event('worker_progress', 2, {
          summary: '改完了',
          nextSteps: '跑测试',
          filesModified: ['a.ts', 'b.ts'],
          detail: { linesAdded: 5 },
        }),
      ],
    });
    expect(entries.find((entry) => entry.kind === 'report')).toMatchObject({
      summary: '改完了',
      nextSteps: '跑测试',
      files: ['a.ts', 'b.ts'],
      stats: { linesAdded: 5 },
    });
  });

  test('system lines come from the record and the quiet events', () => {
    const entries = conversation({
      events: [
        event('lock_acquired', 2, { files: ['a.ts', 'b.ts'] }),
        event('message', 3, { kind: 'plan_written', path: 'plan.md' }),
        event('message', 4, { content: '你好' }),
        event('message', 5, { text: '没有 content' }),
      ],
      workerExitedAt: T0 + 6 * MIN,
    });
    const systems = entries.filter((entry) => entry.kind === 'system');
    expect(systems.map((entry) => entry.text)).toEqual([
      '提交',
      '启动 w1 · pid 4242',
      '锁定 2 个文件',
      '写了计划 · plan.md',
      '消息 · 你好',
      '消息 · 没有 content',
      'worker 退出',
    ]);
    expect(systems[0].seq).toBeUndefined();
    expect(systems[2].seq).toBeDefined();
  });
});
