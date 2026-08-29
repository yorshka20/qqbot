// Nicknames live inside each message's metadata.sender JSON, not in a column, so
// SQL can only pre-filter and the real match happens here. That makes the JS side
// the part worth testing: a card overriding a nickname, bot rows leaking in, or a
// silent pick between two people sharing a name would each mis-attribute messages.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';

interface Row {
  userId: number;
  nickname?: string;
  card?: string;
  isBotReply?: boolean;
}

/** No getRawDb: the service takes the adapter path and finds every row itself. */
function serviceOver(rows: Row[]): ConversationHistoryService {
  const messages = rows.map((r, i) => ({
    id: `m${i}`,
    userId: r.userId,
    content: 'x',
    createdAt: new Date('2026-08-29T03:00:00Z').toISOString(),
    metadata: {
      isBotReply: r.isBotReply === true,
      sender: { nickname: r.nickname, card: r.card },
    },
  }));

  const adapter = {
    isConnected: () => true,
    getModel: (name: string) => {
      if (name === 'conversations') return { findOne: () => Promise.resolve({ id: 'conv-1' }) };
      if (name === 'messages') return { find: () => Promise.resolve(messages) };
      throw new Error(`Unexpected model: ${name}`);
    },
  };

  getContainer().registerInstance(
    DITokens.SUMMARIZE_SERVICE,
    { summarize: () => Promise.resolve('') },
    { allowOverride: true },
  );
  return new ConversationHistoryService({ getAdapter: () => adapter } as unknown as DatabaseManager);
}

async function resolve(rows: Row[], name: string) {
  return serviceOver(rows).findUserIdsByDisplayName('100000001', 'group', name);
}

describe('findUserIdsByDisplayName', () => {
  it('counts a speaker once per message and reports the id', async () => {
    const found = await resolve(
      [
        { userId: 10000001, nickname: '测试用户甲' },
        { userId: 10000001, nickname: '测试用户甲' },
      ],
      '测试用户甲',
    );

    expect(found).toEqual([{ userId: '10000001', displayName: '测试用户甲', messageCount: 2 }]);
  });

  it('matches the group card, which is the name people actually see', async () => {
    const found = await resolve([{ userId: 111, nickname: '本名', card: '甲的群名片' }], '甲的群名片');

    expect(found).toEqual([{ userId: '111', displayName: '甲的群名片', messageCount: 1 }]);
  });

  it('returns every candidate for a shared name, loudest first', async () => {
    const found = await resolve(
      [
        { userId: 222, nickname: 'RPG老哥' },
        { userId: 111, nickname: 'RPG' },
        { userId: 111, nickname: 'RPG' },
      ],
      'rpg',
    );

    expect(found.map((c) => c.userId)).toEqual(['111', '222']);
  });

  it('never attributes the bot to a nickname', async () => {
    const found = await resolve([{ userId: 999, nickname: '机器人自己', isBotReply: true }], '机器人自己');

    expect(found).toEqual([]);
  });

  it('finds nobody rather than everybody for a blank name', async () => {
    const found = await resolve([{ userId: 111, nickname: 'RPG' }], '   ');

    expect(found).toEqual([]);
  });
});
