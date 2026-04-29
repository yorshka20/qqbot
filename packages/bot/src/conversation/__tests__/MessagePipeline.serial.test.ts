import 'reflect-metadata';
import { describe, expect, it, mock } from 'bun:test';
import type { NormalizedMessageEvent } from '@/events/types';
import { MessagePipeline } from '../MessagePipeline';
import type { MessageProcessingContext } from '../types';

function makeEvent(id: string): NormalizedMessageEvent {
  return {
    id,
    type: 'message',
    timestamp: Date.now(),
    protocol: 'milky',
    userId: 1,
    messageType: 'private',
    message: 'hello',
    segments: [],
  } as NormalizedMessageEvent;
}

function makeContext(source: string): MessageProcessingContext {
  return {
    message: makeEvent('ctx'),
    sessionId: `session-${Math.random()}`,
    sessionType: 'user',
    botSelfId: '12345',
    source: source as MessageProcessingContext['source'],
  };
}

function makePipeline(lifecycleExecuteImpl: () => Promise<boolean>) {
  const lifecycle = {
    execute: mock(lifecycleExecuteImpl),
  } as any;

  const hookManager = {
    execute: mock(() => Promise.resolve(true)),
    addHandler: mock(() => {}),
  } as any;

  const contextManager = {
    buildContext: mock(
      (_msg: string, opts: { sessionId: string; sessionType: string; userId: number; groupId: number }) => ({
        userMessage: _msg ?? '',
        history: [],
        userId: opts.userId,
        groupId: opts.groupId,
        messageType: 'private',
        metadata: new Map(),
      }),
    ),
    addMessage: mock(() => Promise.resolve()),
  } as any;

  const conversationConfigService = {
    getUseForwardMsg: mock(() => Promise.resolve(false)),
  } as any;

  const providerRouter = {
    route: mock(() => ({ isExplicitPrefix: false, providerName: null, strippedMessage: '' })),
  } as any;

  return new MessagePipeline(lifecycle, hookManager, contextManager, conversationConfigService, providerRouter);
}

describe('MessagePipeline serial queue', () => {
  it('bilibili-danmaku: processes messages serially', async () => {
    const timestamps: Array<{ start: number; end: number }> = [];

    const pipeline = makePipeline(async () => {
      const entry = { start: Date.now(), end: 0 };
      timestamps.push(entry);
      await new Promise<void>((r) => setTimeout(r, 50));
      entry.end = Date.now();
      return true;
    });

    await Promise.all([
      pipeline.process(makeEvent('msg-1'), makeContext('bilibili-danmaku'), 'bilibili-danmaku'),
      pipeline.process(makeEvent('msg-2'), makeContext('bilibili-danmaku'), 'bilibili-danmaku'),
      pipeline.process(makeEvent('msg-3'), makeContext('bilibili-danmaku'), 'bilibili-danmaku'),
    ]);

    expect(timestamps.length).toBe(3);
    // Each call must start only after the previous call ends (serial)
    expect(timestamps[1].start).toBeGreaterThanOrEqual(timestamps[0].end);
    expect(timestamps[2].start).toBeGreaterThanOrEqual(timestamps[1].end);
  });

  it('qq-private: processes messages in parallel', async () => {
    const startTimes: number[] = [];

    const pipeline = makePipeline(async () => {
      startTimes.push(Date.now());
      await new Promise<void>((r) => setTimeout(r, 50));
      return true;
    });

    await Promise.all([
      pipeline.process(makeEvent('msg-a'), makeContext('qq-private'), 'qq-private'),
      pipeline.process(makeEvent('msg-b'), makeContext('qq-private'), 'qq-private'),
      pipeline.process(makeEvent('msg-c'), makeContext('qq-private'), 'qq-private'),
    ]);

    expect(startTimes.length).toBe(3);
    // All three should start close together (parallel execution)
    const min = Math.min(...startTimes);
    const max = Math.max(...startTimes);
    expect(max - min).toBeLessThan(40);
  });
});
