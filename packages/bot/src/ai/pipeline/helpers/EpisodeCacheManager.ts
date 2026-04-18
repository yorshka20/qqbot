// Episode-based history cache manager.
// Owns the NormalEpisodeService instance and per-episode history cache.

import {
  type ConversationHistoryService,
  type ConversationMessageEntry,
  NormalEpisodeService,
  normalizeSessionId,
} from '@/conversation/history';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';

/** Normal mode: max history entries in prompt (stable size for LLM cache hit). */
const NORMAL_MAX_HISTORY_ENTRIES = 24;

/**
 * Manages episode-based conversation history caching.
 * Owns the {@link NormalEpisodeService} instance and a per-episode history Map
 * so the prompt prefix stays stable across turns (improving LLM cache hit rate).
 * Handles new-episode initialization, incremental appending, and summarization
 * when the history exceeds the configured maximum entry count.
 */
export class EpisodeCacheManager {
  private readonly episodeService = new NormalEpisodeService();

  /** Per-episode history cache so prompt prefix stays stable until summary roll (for LLM cache). */
  private readonly episodeHistoryCache = new Map<string, ConversationMessageEntry[]>();

  constructor(private conversationHistoryService: ConversationHistoryService) {}

  /**
   * Build history for normal (episode) mode.
   * - SessionId is normalized so history and DB persistence use the same key (group:groupId / user:userId).
   * - New episode (no cache): initial context = last EPISODE_CONTEXT_WINDOW_SIZE (10) messages within 10 min before trigger.
   * - Existing episode (has cache): same start (cached prefix) + new messages from DB since last cached; when over cap, summarize front.
   */
  async buildNormalHistoryEntries(context: HookContext): Promise<{
    historyEntries: ConversationMessageEntry[];
    sessionId: string;
    episodeKey: string;
  }> {
    const rawSessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    const canonicalSessionId = normalizeSessionId(
      rawSessionId,
      sessionType,
      context.metadata.get('groupId'),
      context.metadata.get('userId'),
    );
    const now = new Date(context.message.timestamp ?? Date.now());
    const episode = this.episodeService.resolveEpisode({
      sessionId: canonicalSessionId,
      messageId: this.getMessageIdString(context),
      now,
      userMessage: context.message.message,
    });
    const episodeKey = this.episodeService.buildEpisodeKey(canonicalSessionId, episode);
    const currentMessageId = this.getMessageIdString(context);

    let entries: ConversationMessageEntry[];
    const cached = this.episodeHistoryCache.get(episodeKey);

    if (cached != null) {
      // Existing episode: stable start (cached) + new messages since last cached up to (excluding) current trigger.
      // When cache is empty (first turn had no prior context), use contextWindowStart so the bot's own reply
      // from the previous turn is not filtered out by the createdAt <= startedAt gate in the new-episode path.
      const sinceAfterLast =
        cached.length > 0 ? new Date(cached[cached.length - 1].createdAt.getTime() + 1) : episode.contextWindowStart;
      const newMessages = await this.conversationHistoryService.getMessagesSinceForSession(
        canonicalSessionId,
        sessionType,
        sinceAfterLast,
        NORMAL_MAX_HISTORY_ENTRIES + 10,
      );
      const appended = newMessages.filter((e) => e.messageId !== currentMessageId);
      const combined = [...cached, ...appended];
      if (combined.length > NORMAL_MAX_HISTORY_ENTRIES) {
        entries = await this.conversationHistoryService.replaceOldestWithSummary(
          combined,
          NORMAL_MAX_HISTORY_ENTRIES,
          new Date(),
        );
        this.episodeHistoryCache.set(episodeKey, entries);
      } else {
        entries = combined;
        this.episodeHistoryCache.set(episodeKey, entries);
      }
    } else {
      // New episode: last EPISODE_CONTEXT_WINDOW_SIZE (10) messages within 10 min before trigger.
      const raw = await this.conversationHistoryService.getMessagesSinceForSession(
        canonicalSessionId,
        sessionType,
        episode.contextWindowStart,
        500,
      );
      const startedAtTs = episode.startedAt.getTime();
      const inWindow = raw.filter((e) => e.createdAt.getTime() <= startedAtTs && e.messageId !== currentMessageId);
      entries = inWindow.slice(-NormalEpisodeService.EPISODE_CONTEXT_WINDOW_SIZE);
      // When 10-min window is empty, try last N from DB but still restrict to same 10-min window.
      if (entries.length === 0) {
        const contextWindowStartTs = episode.contextWindowStart.getTime();
        const recent = await this.conversationHistoryService.getRecentMessagesForSession(
          canonicalSessionId,
          sessionType,
          100,
        );
        const inWindowFromRecent = recent.filter(
          (e) =>
            e.messageId !== currentMessageId &&
            e.createdAt.getTime() >= contextWindowStartTs &&
            e.createdAt.getTime() <= startedAtTs,
        );
        entries = inWindowFromRecent.slice(-NormalEpisodeService.EPISODE_CONTEXT_WINDOW_SIZE);
      }
      this.episodeHistoryCache.set(episodeKey, entries);
    }

    return { historyEntries: entries, sessionId: canonicalSessionId, episodeKey };
  }

  /**
   * Maintain episode context window: when cache exceeds limit, replace oldest with summary and update cache.
   * Called fire-and-forget after reply completes so the next reply sees a stable summarized prefix.
   */
  async maintainEpisodeContext(episodeKey: string | undefined): Promise<void> {
    if (!episodeKey) {
      return;
    }
    const cached = this.episodeHistoryCache.get(episodeKey);
    if (!cached || cached.length <= NORMAL_MAX_HISTORY_ENTRIES) {
      return;
    }
    try {
      const replaced = await this.conversationHistoryService.replaceOldestWithSummary(
        cached,
        NORMAL_MAX_HISTORY_ENTRIES,
        new Date(),
      );
      this.episodeHistoryCache.set(episodeKey, replaced);
    } catch (err) {
      logger.warn('[EpisodeCacheManager] maintainEpisodeContext failed:', err instanceof Error ? err.message : err);
    }
  }

  private getMessageIdString(context: HookContext): string {
    return String(context.message.id ?? context.message.messageId ?? `msg:${Date.now()}`);
  }
}
