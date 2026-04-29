import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { MessageSource } from '@/conversation/sources';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { SessionStrategyPlugin } from '../SessionStrategyPlugin';

function makeHookContext(source: MessageSource): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', '123');
  metadata.set('sessionId', 's1');
  metadata.set('sessionType', 'user');
  metadata.set('conversationId', 'c1');
  metadata.set('userId', 456);
  metadata.set('groupId', 0);
  metadata.set('senderRole', 'user');
  return {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 456,
      groupId: 0,
      messageType: 'private',
      message: 'test',
      segments: [],
    },
    context: {
      userMessage: 'test',
      history: [],
      userId: 456,
      groupId: 0,
      messageType: 'private',
      metadata: new Map(),
    },
    metadata,
    source,
  };
}

describe('SessionStrategyPlugin', () => {
  it('avatar-cmd → historyAdapterKind is live2d-session', async () => {
    const plugin = new SessionStrategyPlugin({
      name: 'session-strategy',
      version: 'test',
      description: 'test',
    });
    const context = makeHookContext('avatar-cmd');
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('historyAdapterKind')).toBe('live2d-session');
  });

  it('qq-private → historyAdapterKind is conversation-history', async () => {
    const plugin = new SessionStrategyPlugin({
      name: 'session-strategy',
      version: 'test',
      description: 'test',
    });
    const context = makeHookContext('qq-private');
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('historyAdapterKind')).toBe('conversation-history');
  });

  it('bilibili-danmaku → historyAdapterKind is live2d-session', async () => {
    const plugin = new SessionStrategyPlugin({
      name: 'session-strategy',
      version: 'test',
      description: 'test',
    });
    const context = makeHookContext('bilibili-danmaku');
    await plugin.onMessagePreprocess(context);
    expect(context.metadata.get('historyAdapterKind')).toBe('live2d-session');
  });
});
