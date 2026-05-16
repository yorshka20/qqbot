import 'reflect-metadata';

import { describe, expect, it, vi } from 'bun:test';
import { DatabasePersistenceSystem } from '@/conversation/systems/DatabasePersistenceSystem';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/message/MessageCache', () => ({
  cacheMessage: vi.fn(),
}));

function fakeConversationModel() {
  return {
    findOne: async () => null,
    create: async (data: Record<string, unknown>) => ({ id: 'conv-1', ...data }),
    update: async () => {},
    count: async () => 5,
  };
}

function fakeMessageModel(lastBotMessageCreated: (data: unknown) => void) {
  return {
    findOne: async () => null,
    create: async (data: unknown) => {
      lastBotMessageCreated(data);
      return data;
    },
    update: async () => {},
    count: async () => 5,
  };
}

function fakeAdapter(lastBotMessageCreated: (data: unknown) => void) {
  return {
    isConnected: () => true,
    getModel: (name: string) => {
      if (name === 'conversations') return fakeConversationModel();
      if (name === 'messages') return fakeMessageModel(lastBotMessageCreated);
      throw new Error(`unknown model: ${name}`);
    },
  };
}

function fakeDatabaseManager(lastBotMessageCreated: (data: unknown) => void): DatabaseManager {
  return {
    getAdapter: () => fakeAdapter(lastBotMessageCreated),
  } as unknown as DatabaseManager;
}

function makeContext(overrides: {
  replySubtext?: string;
  replyTagsMeta?: string[];
} = {}): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('sessionId', 'group:123');
  metadata.set('sessionType', 'group');
  metadata.set('groupId', 123);
  metadata.set('userId', 456);
  metadata.set('botSelfId', '100');
  metadata.set('postProcessOnly', false);
  metadata.set('whitelistDenied', false);
  metadata.set('groupUseForwardMsg', false);
  metadata.set('whitelistUser', false);
  metadata.set('whitelistGroup', false);
  metadata.set('inProactiveThread', false);
  metadata.set('proactiveThreadId', '');
  metadata.set('conversationId', '');
  metadata.set('senderRole', 'user');
  metadata.set('replyOnly', false);
  if (overrides.replySubtext !== undefined) {
    metadata.set('replySubtext', overrides.replySubtext);
  }
  if (overrides.replyTagsMeta !== undefined) {
    metadata.set('replyTagsMeta', overrides.replyTagsMeta);
  }

  return {
    message: {
      id: '1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 456,
      groupId: 123,
      messageType: 'group',
      message: 'hello',
      segments: [],
    },
    context: {
      userMessage: 'hello',
      history: [],
      userId: 456,
      groupId: 123,
      messageType: 'group',
      metadata: new Map(),
    },
    metadata,
    source: 'qq-group' as const,
    reply: {
      source: 'ai',
      segments: [{ type: 'text', data: { text: 'bot reply' } }],
    },
    sentMessageResponse: { message_seq: 42 },
    ...overrides,
  } as HookContext;
}

describe('DatabasePersistenceSystem handleMessageSent subtext persist', () => {
  it('persists subtext and replyTags in bot-reply metadata when present', async () => {
    let lastCreated: any = null;
    const db = fakeDatabaseManager((data) => {
      lastCreated = data;
    });
    const system = new DatabasePersistenceSystem(db);
    const ctx = makeContext({ replySubtext: 'secret', replyTagsMeta: ['x', 'y'] });

    await system['handleMessageSent'](ctx);

    expect(lastCreated).not.toBeNull();
    expect(lastCreated.metadata).toBeDefined();
    expect(lastCreated.metadata.isBotReply).toBe(true);
    expect(lastCreated.metadata.subtext).toBe('secret');
    expect(lastCreated.metadata.replyTags).toEqual(['x', 'y']);
    expect(lastCreated.metadata.timestamp).toBeDefined();
  });

  it('omits subtext and replyTags keys when not present in metadata', async () => {
    let lastCreated: any = null;
    const db = fakeDatabaseManager((data) => {
      lastCreated = data;
    });
    const system = new DatabasePersistenceSystem(db);
    const ctx = makeContext({});

    await system['handleMessageSent'](ctx);

    expect(lastCreated).not.toBeNull();
    expect(lastCreated.metadata.isBotReply).toBe(true);
    expect(lastCreated.metadata.timestamp).toBeDefined();
    expect(lastCreated.metadata).not.toHaveProperty('subtext');
    expect(lastCreated.metadata).not.toHaveProperty('replyTags');
  });
});
