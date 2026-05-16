import 'reflect-metadata';
import { describe, expect, it, beforeAll } from 'bun:test';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { DITokens } from '@/core/DITokens';
import { getContainer } from '@/core/DIContainer';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';

describe('appendBotReplyToGroup metadata', () => {
  let captured: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    captured = [];

    const fakeMessagesModel = {
      create: (row: Record<string, unknown>) => {
        captured.push(row);
        return Promise.resolve({ id: 1, ...row });
      },
      count: () => Promise.resolve(1),
    };

    const fakeConversationsModel = {
      findOne: () => Promise.resolve(null),
      create: (row: Record<string, unknown>) => Promise.resolve({ id: 'conv-1', ...row }),
      update: () => Promise.resolve(),
    };

    const adapter = {
      isConnected: () => true,
      getModel: (name: string) => {
        if (name === 'messages') return fakeMessagesModel;
        if (name === 'conversations') return fakeConversationsModel;
        throw new Error(`Unexpected model: ${name}`);
      },
    };

    const fakeDatabaseManager = {
      getAdapter: () => adapter,
    } as unknown as DatabaseManager;

    const fakeSummarizeService = { summarize: () => Promise.resolve('summary') };

    getContainer().registerInstance(DITokens.SUMMARIZE_SERVICE, fakeSummarizeService, {
      allowOverride: true,
    });

    const service = new ConversationHistoryService(fakeDatabaseManager);

    Object.defineProperty(globalThis, '__testService', {
      value: service,
      writable: false,
      configurable: true,
    });
  });

  function getService(): ConversationHistoryService {
    return (globalThis as Record<string, unknown>).__testService as ConversationHistoryService;
  }

  it('persists subtext and replyTags in metadata', async () => {
    captured = [];
    await getService().appendBotReplyToGroup('group:123', 'hi', 'milky', {
      subtext: 'secret',
      replyTags: ['a', 'b'],
    });

    expect(captured.length).toBe(1);
    expect(captured[0].metadata).toBeDefined();
    const meta = captured[0].metadata as Record<string, unknown>;
    expect(meta.subtext).toBe('secret');
    expect(meta.replyTags).toEqual(['a', 'b']);
    expect(meta.isBotReply).toBe(true);
  });

  it('omits subtext and replyTags when not provided', async () => {
    captured = [];
    await getService().appendBotReplyToGroup('group:123', 'hi', 'milky');

    expect(captured.length).toBe(1);
    const meta = captured[0].metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty('subtext');
    expect(meta).not.toHaveProperty('replyTags');
    expect(meta.isBotReply).toBe(true);
    expect(meta).toHaveProperty('timestamp');
  });

  it('omits subtext and replyTags when empty', async () => {
    captured = [];
    await getService().appendBotReplyToGroup('group:123', 'hi', 'milky', {
      subtext: '',
      replyTags: [],
    });

    expect(captured.length).toBe(1);
    const meta = captured[0].metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty('subtext');
    expect(meta).not.toHaveProperty('replyTags');
    expect(meta.isBotReply).toBe(true);
  });
});
