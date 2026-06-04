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

function makeContext(source: string, sessionId: string): MessageProcessingContext {
  return {
    message: makeEvent('ctx'),
    sessionId,
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

describe('MessagePipeline concurrency modes', () => {
  it('drop mode (qq-private): drops same-session messages while one is in flight', async () => {
    let executions = 0;

    const pipeline = makePipeline(async () => {
      executions++;
      await new Promise<void>((r) => setTimeout(r, 50));
      return true;
    });

    const [r1, r2, r3] = await Promise.all([
      pipeline.process(makeEvent('msg-1'), makeContext('qq-private', 'user:1'), 'qq-private'),
      pipeline.process(makeEvent('msg-2'), makeContext('qq-private', 'user:1'), 'qq-private'),
      pipeline.process(makeEvent('msg-3'), makeContext('qq-private', 'user:1'), 'qq-private'),
    ]);

    // Only the first message runs the lifecycle; the other two are dropped (no LLM call).
    expect(executions).toBe(1);
    expect(r1.success).toBe(true);
    expect(r2.dropped).toBe(true);
    expect(r3.dropped).toBe(true);
  });

  it('drop mode (qq-private): different sessions process independently', async () => {
    let executions = 0;

    const pipeline = makePipeline(async () => {
      executions++;
      await new Promise<void>((r) => setTimeout(r, 50));
      return true;
    });

    const [r1, r2] = await Promise.all([
      pipeline.process(makeEvent('msg-1'), makeContext('qq-private', 'user:1'), 'qq-private'),
      pipeline.process(makeEvent('msg-2'), makeContext('qq-private', 'user:2'), 'qq-private'),
    ]);

    expect(executions).toBe(2);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.dropped).toBeUndefined();
    expect(r2.dropped).toBeUndefined();
  });

  it('drop mode (qq-private): session frees up after the in-flight message finishes', async () => {
    let executions = 0;

    const pipeline = makePipeline(async () => {
      executions++;
      await new Promise<void>((r) => setTimeout(r, 10));
      return true;
    });

    const r1 = await pipeline.process(makeEvent('msg-1'), makeContext('qq-private', 'user:1'), 'qq-private');
    const r2 = await pipeline.process(makeEvent('msg-2'), makeContext('qq-private', 'user:1'), 'qq-private');

    // Sequential calls both run — the gate only blocks concurrent in-flight messages.
    expect(executions).toBe(2);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it('concurrent mode (qq-group): processes same-session messages in parallel', async () => {
    const startTimes: number[] = [];

    const pipeline = makePipeline(async () => {
      startTimes.push(Date.now());
      await new Promise<void>((r) => setTimeout(r, 50));
      return true;
    });

    await Promise.all([
      pipeline.process(makeEvent('msg-a'), makeContext('qq-group', 'group:1'), 'qq-group'),
      pipeline.process(makeEvent('msg-b'), makeContext('qq-group', 'group:1'), 'qq-group'),
      pipeline.process(makeEvent('msg-c'), makeContext('qq-group', 'group:1'), 'qq-group'),
    ]);

    expect(startTimes.length).toBe(3);
    // All three should start close together (parallel execution)
    const min = Math.min(...startTimes);
    const max = Math.max(...startTimes);
    expect(max - min).toBeLessThan(40);
  });
});
