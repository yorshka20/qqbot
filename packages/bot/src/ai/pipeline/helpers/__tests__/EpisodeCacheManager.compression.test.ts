/**
 * Unit tests for EpisodeCacheManager window compression:
 * the read path must never summarize, and a fold must land on the live window.
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
import { EpisodeCacheManager } from '../EpisodeCacheManager';

const SESSION_ID = 'group:1';

function makeEntry(index: number, contentLength = 20): ConversationMessageEntry {
  return {
    messageId: `m${index}`,
    userId: 100 + (index % 3),
    content: 'x'.repeat(contentLength),
    isBotReply: index % 4 === 0,
    createdAt: new Date(2026, 0, 1, 0, 0, index),
  };
}

function makeHistoryService(
  entries: ConversationMessageEntry[],
  roll: (input: ConversationMessageEntry[], maxEntries: number) => Promise<SummaryRollResult>,
): ConversationHistoryService & { replaceOldestWithSummary: ReturnType<typeof vi.fn> } {
  return {
    getMessagesSinceForSession: vi.fn().mockResolvedValue(entries),
    getRecentMessagesForSession: vi.fn().mockResolvedValue(entries),
    replaceOldestWithSummary: vi.fn(roll),
  } as unknown as ConversationHistoryService & { replaceOldestWithSummary: ReturnType<typeof vi.fn> };
}

/** Real fold, so the target size the manager asks for is exercised end to end. */
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

function makeContext(messageId: string): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('sessionId', SESSION_ID);
  metadata.set('sessionType', 'group');
  metadata.set('groupId', 1);
  return {
    message: { id: messageId, message: 'hi', timestamp: Date.UTC(2026, 0, 1, 1, 0, 0) },
    metadata,
  } as unknown as HookContext;
}

describe('EpisodeCacheManager — read path', () => {
  it('never summarizes while building history, however long the window is', async () => {
    const history = Array.from({ length: 400 }, (_, i) => makeEntry(i));
    const service = makeHistoryService(history, fold);
    const manager = new EpisodeCacheManager(service);

    // First build seeds the episode, second one appends the whole backlog on top.
    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const result = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));

    expect(service.replaceOldestWithSummary).not.toHaveBeenCalled();
    expect(result.historyEntries.length).toBeGreaterThan(0);
  });

  it('bounds the window without an LLM when compression cannot keep up', async () => {
    const history = Array.from({ length: 400 }, (_, i) => makeEntry(i));
    const service = makeHistoryService(history, fold);
    const manager = new EpisodeCacheManager(service);

    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const result = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));

    expect(result.historyEntries.length).toBeLessThanOrEqual(150);
    // The bound keeps the recent end, not the stale front.
    const last = result.historyEntries[result.historyEntries.length - 1];
    expect(last.messageId).toBe('m399');
  });
});

describe('EpisodeCacheManager — background compression', () => {
  it('leaves a window under budget untouched', async () => {
    const service = makeHistoryService(Array.from({ length: 30 }, (_, i) => makeEntry(i)), fold);
    const manager = new EpisodeCacheManager(service);
    const { episodeKey } = await manager.buildNormalHistoryEntries(makeContext('trigger-1'));

    await manager.maintainEpisodeContext(episodeKey);

    expect(service.replaceOldestWithSummary).not.toHaveBeenCalled();
  });

  it('folds an over-budget window down to the target and shows it on the next build', async () => {
    const history = Array.from({ length: 120 }, (_, i) => makeEntry(i));
    const service = makeHistoryService(history, fold);
    const manager = new EpisodeCacheManager(service);

    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const beforeFold = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));
    expect(beforeFold.historyEntries[0].isSummary).toBeUndefined();

    // Nothing new arrives, so the next build sees exactly the folded window.
    service.getMessagesSinceForSession = vi.fn().mockResolvedValue([]);
    await manager.maintainEpisodeContext(beforeFold.episodeKey);
    const afterFold = await manager.buildNormalHistoryEntries(makeContext('trigger-3'));

    expect(afterFold.historyEntries.length).toBe(48);
    expect(afterFold.historyEntries[0].isSummary).toBe(true);
    expect(afterFold.historyEntries[afterFold.historyEntries.length - 1].messageId).toBe('m119');
  });

  it('keeps entries appended while the summarizer was running', async () => {
    const history = Array.from({ length: 120 }, (_, i) => makeEntry(i));
    let releaseSummarizer: () => void = () => {};
    const summarizerStarted = new Promise<void>((resolve) => {
      releaseSummarizer = resolve;
    });
    const service = makeHistoryService(history, async (input, maxEntries) => {
      releaseSummarizer();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fold(input, maxEntries);
    });
    const manager = new EpisodeCacheManager(service);

    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const built = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));

    const latecomer = makeEntry(500);
    service.getMessagesSinceForSession = vi.fn().mockResolvedValue([latecomer]);

    const compression = manager.maintainEpisodeContext(built.episodeKey);
    await summarizerStarted;
    await manager.buildNormalHistoryEntries(makeContext('trigger-3'));
    await compression;

    const afterFold = await manager.buildNormalHistoryEntries(makeContext('trigger-4'));
    expect(afterFold.historyEntries[0].isSummary).toBe(true);
    expect(afterFold.historyEntries[afterFold.historyEntries.length - 1].messageId).toBe('m500');
  });

  it('leaves the window intact when the summarizer produces nothing', async () => {
    const history = Array.from({ length: 120 }, (_, i) => makeEntry(i));
    const service = makeHistoryService(history, async (input) => ({
      entries: input.slice(-48),
      replacedCount: 0,
    }));
    const manager = new EpisodeCacheManager(service);

    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const built = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));
    const sizeBefore = built.historyEntries.length;

    service.getMessagesSinceForSession = vi.fn().mockResolvedValue([]);
    await manager.maintainEpisodeContext(built.episodeKey);
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3'));

    expect(after.historyEntries.length).toBe(sizeBefore);
    expect(after.historyEntries[0].isSummary).toBeUndefined();
  });

  it('folds on the char budget before the entry count runs out', async () => {
    // 60 entries, well under the 100-entry trigger, but far past the char trigger.
    const history = Array.from({ length: 60 }, (_, i) => makeEntry(i, 600));
    const service = makeHistoryService(history, fold);
    const manager = new EpisodeCacheManager(service);

    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const built = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));
    expect(built.historyEntries.length).toBeLessThanOrEqual(100);

    service.getMessagesSinceForSession = vi.fn().mockResolvedValue([]);
    await manager.maintainEpisodeContext(built.episodeKey);
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3'));

    expect(after.historyEntries[0].isSummary).toBe(true);
    // Folded to the char target, not all the way to the entry target.
    const keptChars = after.historyEntries.slice(1).reduce((sum, e) => sum + e.content.length, 0);
    expect(keptChars).toBeLessThanOrEqual(10_000);
    expect(after.historyEntries.length).toBeGreaterThan(8);
  });

  it('does not fold the window below the recent-entry floor for one huge entry', async () => {
    const history = [
      ...Array.from({ length: 110 }, (_, i) => makeEntry(i)),
      makeEntry(999, 50_000),
    ];
    const service = makeHistoryService(history, fold);
    const manager = new EpisodeCacheManager(service);

    await manager.buildNormalHistoryEntries(makeContext('trigger-1'));
    const built = await manager.buildNormalHistoryEntries(makeContext('trigger-2'));

    service.getMessagesSinceForSession = vi.fn().mockResolvedValue([]);
    await manager.maintainEpisodeContext(built.episodeKey);
    const after = await manager.buildNormalHistoryEntries(makeContext('trigger-3'));

    // 1 summary + at least the 8-entry floor.
    expect(after.historyEntries.length).toBeGreaterThanOrEqual(9);
    expect(after.historyEntries[0].isSummary).toBe(true);
  });
});
