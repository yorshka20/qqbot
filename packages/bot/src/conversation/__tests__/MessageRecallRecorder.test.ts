import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import { EpisodeCacheManager } from '@/ai/pipeline/helpers/EpisodeCacheManager';
import { buildHistoryEntryPrefix, RECALLED_MARKER } from '@/ai/prompt/speakerTag';
import type { SummarizeService } from '@/ai/services/SummarizeService';
import { MessageRecallRecorder } from '@/conversation/MessageRecallRecorder';
import { formatSingleEntryToText } from '@/conversation/history';
import {
  type ConversationMessageEntry,
  ConversationHistoryService,
} from '@/conversation/history/ConversationHistoryService';
import type { ThreadService } from '@/conversation/thread/ThreadService';
import type { Config } from '@/core/config';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { NormalizedNoticeEvent } from '@/events/types';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';

const GROUP_ID = 20000001;
const SESSION_ID = `group:${GROUP_ID}`;

/** A history service over an in-memory messages table holding `rows` in one group conversation. */
function historyServiceOver(rows: Message[]): ConversationHistoryService {
  const conversation = { id: 'conv-1', sessionId: SESSION_ID, sessionType: 'group' };
  const matches = (row: Message, criteria: Partial<Message>) =>
    Object.entries(criteria).every(([key, value]) => row[key as keyof Message] === value);
  const adapter = {
    isConnected: () => true,
    getModel: (name: string) => {
      if (name === 'conversations') {
        return {
          findOne: async (q: { sessionId: string }) => (q.sessionId === SESSION_ID ? conversation : null),
        };
      }
      return {
        find: async (criteria: Partial<Message>, options?: { order?: 'asc' | 'desc' }) => {
          const found = rows.filter((row) => matches(row, criteria));
          return options?.order === 'desc' ? [...found].reverse() : found;
        },
        update: async (id: string, data: Partial<Message>) => {
          const row = rows.find((r) => r.id === id) as Message;
          Object.assign(row, data);
          return row;
        },
      };
    },
  };
  return new ConversationHistoryService(
    { getAdapter: () => adapter } as unknown as DatabaseManager,
    {} as SummarizeService,
    {} as ThreadService,
    { getContextMemoryConfig: () => undefined } as unknown as Config,
  );
}

function row(id: string, messageSeq: number, content: string, isBotReply: boolean, minute: number): Message {
  return {
    id,
    conversationId: 'conv-1',
    userId: isBotReply ? 10000009 : 10000001,
    messageType: 'group',
    groupId: GROUP_ID,
    content,
    protocol: 'milky',
    messageSeq,
    metadata: { isBotReply },
    createdAt: new Date(Date.UTC(2026, 8, 29, 10, minute)),
    updatedAt: new Date(Date.UTC(2026, 8, 29, 10, minute)),
  };
}

function recallNotice(messageSeq: number): NormalizedNoticeEvent {
  return {
    id: 'n1',
    type: 'notice',
    timestamp: Date.UTC(2026, 8, 29, 10, 5),
    protocol: 'milky',
    noticeType: 'message_recall',
    messageType: 'group',
    groupId: GROUP_ID,
    messageSeq,
    senderId: 10000009,
    operatorId: 10000009,
  };
}

describe('MessageRecallRecorder', () => {
  it('marks the stored row, keeping its text, and history reads it back as recalled', async () => {
    const rows = [row('a', 101, '明天大概率下雨', true, 1), row('b', 102, '收到', false, 2)];
    const history = historyServiceOver(rows);
    const episodeCache = { markRecalled: vi.fn() } as unknown as EpisodeCacheManager;

    await new MessageRecallRecorder(history, episodeCache).record(recallNotice(101));

    expect(rows[0].metadata?.recalledAt).toBe(new Date(Date.UTC(2026, 8, 29, 10, 5)).toISOString());
    expect(rows[0].metadata?.recalledBy).toBe(10000009);
    expect(rows[0].metadata?.isBotReply).toBe(true);
    expect(episodeCache.markRecalled).toHaveBeenCalledWith(SESSION_ID, 101);

    const entries = await history.getRecentMessagesForSession(SESSION_ID, 'group', 10);
    expect(entries.map((e) => [e.content, e.recalled])).toEqual([
      ['明天大概率下雨', true],
      ['收到', false],
    ]);
  });

  it('leaves the live window alone when no stored row carries the sequence number', async () => {
    const history = historyServiceOver([row('a', 101, '明天大概率下雨', true, 1)]);
    const episodeCache = { markRecalled: vi.fn() } as unknown as EpisodeCacheManager;

    await new MessageRecallRecorder(history, episodeCache).record(recallNotice(999));

    expect(episodeCache.markRecalled).not.toHaveBeenCalled();
  });
});

describe('EpisodeCacheManager.markRecalled', () => {
  it('marks the entry in the cached window that the next turn is built from', async () => {
    const cached: ConversationMessageEntry[] = [
      { messageId: 'a', messageSeq: 101, userId: 1, content: '明天大概率下雨', isBotReply: true, createdAt: new Date(1) },
      { messageId: 'b', messageSeq: 102, userId: 2, content: '收到', isBotReply: false, createdAt: new Date(2) },
    ];
    const history = {
      getMessagesSinceForSession: vi.fn().mockResolvedValueOnce(cached).mockResolvedValue([]),
    } as unknown as ConversationHistoryService;
    const manager = new EpisodeCacheManager(history);
    const metadata = new HookMetadataMap();
    metadata.set('sessionId', SESSION_ID);
    metadata.set('sessionType', 'group');
    metadata.set('groupId', GROUP_ID);
    const context = (id: string) =>
      ({ message: { id, message: 'hi', timestamp: 60_000 }, metadata }) as unknown as HookContext;

    await manager.buildNormalHistoryEntries(context('t1'));
    manager.markRecalled(SESSION_ID, 101);
    const { historyEntries } = await manager.buildNormalHistoryEntries(context('t2'));

    expect(historyEntries.map((e) => e.recalled ?? false)).toEqual([true, false]);
  });
});

describe('recall marker rendering', () => {
  const base = { messageId: 'a', userId: 10000001, nickname: '甲', content: '原话', createdAt: new Date(0) };

  it("leads a recalled bot turn with the marker and nothing else, like the bot's other turns", () => {
    expect(buildHistoryEntryPrefix({ ...base, isBotReply: true, recalled: true })).toBe(RECALLED_MARKER);
    expect(buildHistoryEntryPrefix({ ...base, isBotReply: true })).toBe('');
  });

  it('puts the marker after the time and speaker on a user turn', () => {
    const prefix = buildHistoryEntryPrefix({ ...base, isBotReply: false, recalled: true });
    expect(prefix.endsWith(`[speaker:甲:10000001] ${RECALLED_MARKER}`)).toBe(true);
  });

  it('marks flat-text renderings too', () => {
    expect(formatSingleEntryToText({ ...base, isBotReply: false, recalled: true })).toContain(
      `: ${RECALLED_MARKER} 原话`,
    );
  });
});
