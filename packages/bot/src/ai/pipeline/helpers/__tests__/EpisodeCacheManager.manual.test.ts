/**
 * Unit tests for the on-request context controls behind /compress:
 * a manual fold of the live window, and a cut that restarts the session's context.
 */

import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import type {
  ConversationHistoryService,
  ConversationMessageEntry,
  SummaryRollResult,
} from '@/conversation/history';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES, EpisodeCacheManager } from '../EpisodeCacheManager';

const SESSION_ID = 'group:1';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const minutes = (n: number) => n * 60 * 1000;

function makeEntry(id: string, at: number, content = 'hello'): ConversationMessageEntry {
  return { messageId: id, userId: 100, content, isBotReply: false, createdAt: new Date(at) };
}

/** A store that answers "messages since" the way the DB does, so a cut is visible in what comes back. */
function makeHistoryService(
  store: ConversationMessageEntry[],
  roll: (input: ConversationMessageEntry[], maxEntries: number) => Promise<SummaryRollResult> = fold,
): ConversationHistoryService & { replaceOldestWithSummary: ReturnType<typeof vi.fn> } {
  return {
    getMessagesSinceForSession: vi.fn(async (_sessionId: string, _type: string, since: Date) =>
      store.filter((e) => e.createdAt.getTime() >= since.getTime()),
    ),
    getRecentMessagesForSession: vi.fn(async () => store),
    replaceOldestWithSummary: vi.fn(roll),
  } as unknown as ConversationHistoryService & { replaceOldestWithSummary: ReturnType<typeof vi.fn> };
}

async function fold(input: ConversationMessageEntry[], maxEntries: number): Promise<SummaryRollResult> {
  if (input.length <= maxEntries) {
    return { entries: input, replacedCount: 0 };
  }
  const numToSummarize = input.length - (maxEntries - 1);
  const summary: ConversationMessageEntry = {
    messageId: 'summary:1',
    userId: 0,
    content: 'SUMMARY',
    isBotReply: false,
    isSummary: true,
    createdAt: input[0].createdAt,
  };
  return { entries: [summary, ...input.slice(numToSummarize)], replacedCount: numToSummarize };
}

function makeContext(messageId: string, at: number): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('sessionId', SESSION_ID);
  metadata.set('sessionType', 'group');
  metadata.set('groupId', 1);
  return { message: { id: messageId, message: 'hi', timestamp: at }, metadata } as unknown as HookContext;
}

/** Seed a live window holding `count` entries: a first build, then everything else appended. */
async function seedWindow(manager: EpisodeCacheManager, store: ConversationMessageEntry[], count: number) {
  for (let i = 0; i < count; i++) {
    store.push(makeEntry(`m${i}`, T0 + i * 1000));
  }
  await manager.buildNormalHistoryEntries(makeContext('trigger-1', T0 + count * 1000));
  return manager.buildNormalHistoryEntries(makeContext('trigger-2', T0 + count * 1000 + 1));
}

describe('EpisodeCacheManager.compressSession', () => {
  it('folds all but the last few entries and shows the fold on the next build', async () => {
    const store: ConversationMessageEntry[] = [];
    const service = makeHistoryService(store);
    const manager = new EpisodeCacheManager(service);
    const seeded = await seedWindow(manager, store, 30);

    const result = await manager.compressSession(SESSION_ID, new Date(T0 + minutes(1)));

    expect(result.status).toBe('compressed');
    if (result.status === 'compressed') {
      expect(result.foldedEntries).toBe(seeded.historyEntries.length - EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES);
      expect(result.charsAfter).toBeLessThan(result.charsBefore);
    }
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3', T0 + minutes(1)));
    expect(after.historyEntries[0].isSummary).toBe(true);
    expect(after.historyEntries.slice(1).map((e) => e.messageId)).toEqual(
      seeded.historyEntries.slice(-EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES).map((e) => e.messageId),
    );
  });

  it('reports no window for a session the bot has not answered', async () => {
    const manager = new EpisodeCacheManager(makeHistoryService([]));

    expect(await manager.compressSession(SESSION_ID, new Date(T0))).toEqual({ status: 'no-window' });
  });

  it('reports no window once the episode has gone idle, since the next turn starts fresh', async () => {
    const store: ConversationMessageEntry[] = [];
    const service = makeHistoryService(store);
    const manager = new EpisodeCacheManager(service);
    await seedWindow(manager, store, 30);

    const result = await manager.compressSession(SESSION_ID, new Date(T0 + minutes(120)));

    expect(result).toEqual({ status: 'no-window' });
    expect(service.replaceOldestWithSummary).not.toHaveBeenCalled();
  });

  it('leaves a window that is already short alone', async () => {
    const store: ConversationMessageEntry[] = [];
    const service = makeHistoryService(store);
    const manager = new EpisodeCacheManager(service);
    await seedWindow(manager, store, EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES);

    const result = await manager.compressSession(SESSION_ID, new Date(T0 + minutes(1)));

    expect(result.status).toBe('too-short');
    expect(service.replaceOldestWithSummary).not.toHaveBeenCalled();
  });

  it('refuses while another fold of the same window is in flight', async () => {
    const store: ConversationMessageEntry[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = makeHistoryService(store, async (input, maxEntries) => {
      await gate;
      return fold(input, maxEntries);
    });
    const manager = new EpisodeCacheManager(service);
    await seedWindow(manager, store, 30);

    const first = manager.compressSession(SESSION_ID, new Date(T0 + minutes(1)));
    const second = await manager.compressSession(SESSION_ID, new Date(T0 + minutes(1)));
    release();

    expect(second).toEqual({ status: 'busy' });
    expect((await first).status).toBe('compressed');
  });

  it('keeps the window as it was when the summarizer yields nothing', async () => {
    const store: ConversationMessageEntry[] = [];
    const service = makeHistoryService(store, async (input) => ({ entries: input, replacedCount: 0 }));
    const manager = new EpisodeCacheManager(service);
    const seeded = await seedWindow(manager, store, 30);

    const result = await manager.compressSession(SESSION_ID, new Date(T0 + minutes(1)));
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3', T0 + minutes(1)));

    expect(result).toEqual({ status: 'failed' });
    expect(after.historyEntries.map((e) => e.messageId)).toEqual(seeded.historyEntries.map((e) => e.messageId));
  });
});

describe('EpisodeCacheManager.clearSession', () => {
  it('empties the live window and lets only later messages back in', async () => {
    const store: ConversationMessageEntry[] = [];
    const manager = new EpisodeCacheManager(makeHistoryService(store));
    await seedWindow(manager, store, 30);
    const cut = T0 + minutes(1);

    manager.clearSession(SESSION_ID, new Date(cut));
    store.push(makeEntry('after-cut', cut + 1000));
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3', cut + 2000));

    expect(after.historyEntries.map((e) => e.messageId)).toEqual(['after-cut']);
  });

  it('holds the cut for an episode that opens after the current one goes idle', async () => {
    const store: ConversationMessageEntry[] = [];
    const manager = new EpisodeCacheManager(makeHistoryService(store));
    await seedWindow(manager, store, 30);
    // The cut lands inside the lookback a fresh episode would otherwise take.
    const cut = T0 + minutes(40);
    store.push(makeEntry('before-cut', cut - minutes(2)));

    manager.clearSession(SESSION_ID, new Date(cut));
    store.push(makeEntry('after-cut', cut + minutes(1)));
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3', cut + minutes(2)));

    expect(after.historyEntries.map((e) => e.messageId)).toEqual(['after-cut']);
  });
});
