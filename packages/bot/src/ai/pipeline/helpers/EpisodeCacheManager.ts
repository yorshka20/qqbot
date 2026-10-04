// Episode-based history cache manager.
// Owns the NormalEpisodeService instance and per-episode history cache.

import { inject, singleton } from 'tsyringe';
import { type ConversationMessageEntry, NormalEpisodeService, normalizeSessionId } from '@/conversation/history';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';

/**
 * Window sizing.
 *
 * The read path never summarizes. It appends and hands back whatever is materialized,
 * so a turn's latency never contains a summarizer round-trip; compression runs after
 * the reply and its result is picked up by the *next* turn.
 *
 * Trigger and target are deliberately far apart. Folding back down to the trigger would
 * leave the window sitting on the boundary and re-summarize every turn, which (a) re-cooks
 * the previous summary into a lossier one on each pass, since the leading entry of the
 * folded span is itself a summary, and (b) changes the prompt prefix every turn, defeating
 * the provider-side prefix cache this cache exists to keep warm.
 */
export const EPISODE_WINDOW_COMPRESS_TRIGGER_ENTRIES = 100;
/** Entries left after a pass: the oldest span collapses into one summary entry. */
export const EPISODE_WINDOW_COMPRESS_TARGET_ENTRIES = 48;
/**
 * Second budget dimension. Entry count varies by an order of magnitude per entry — a one-line
 * "嗯" and a rendered card both count as 1 — so a window can blow a prompt budget well before it
 * reaches the entry trigger. It gets the same trigger/target spread as the entry dimension: a
 * char budget that only bounded the trigger would fold to entries that are still over budget
 * and fire again next turn, which is the boundary-sitting this whole split exists to avoid.
 *
 * Sizing rule — the window is sized for cost, not for what the models can hold: a reply
 * re-sends it on every loop round (a plain reply is usually two: the text, then end_turn),
 * so its size multiplies straight into the bill.
 * - The TARGET is the window's steady floor right after a fold, so it must still hold
 *   3 bot turns WITH their reasoning even when turns are heavy. Measured over real
 *   llm-dumps (2026-08-28..31, 220 reply turns), per-turn persisted reasoning is
 *   p50≈1.6K / p90≈8.6K / p99≈21.7K chars — 24K ≈ 3 heavy (p90) turns.
 * - The TRIGGER is the 2× spread above it: 48K chars (≈ 30–48K tokens, mixed CJK ≈
 *   0.6–1 token/char) on top of the fixed system prompt and tool definitions, which
 *   measured ≈17K tokens over 2026-09-28..10-04.
 * - Fallback capacity does NOT bound the budget (owner decision): fallbacks are
 *   best-effort, and one that cannot fit the prompt is allowed to fail rather than
 *   shrink the window for everyone.
 * Counted chars include each bot entry's persisted reasoning (`entry.reasoning`), which is
 * replayed into the prompt on the turn's reasoning channel and is often longer than the reply itself.
 */
export const EPISODE_WINDOW_COMPRESS_TRIGGER_CHARS = 48_000;
export const EPISODE_WINDOW_COMPRESS_TARGET_CHARS = 24_000;
/**
 * Floor on recent entries kept, whatever the char budget says. A window is a conversation before
 * it is a token count, and a couple of long cards must not be able to fold everything behind them.
 */
export const EPISODE_WINDOW_MIN_RECENT_ENTRIES = 8;
/**
 * Ceiling the read path enforces by dropping oldest, without an LLM. Only reached while
 * compression is failing or cannot keep up; the summary is how a dropped span normally
 * survives, so this is degradation, not the routine path.
 */
export const EPISODE_WINDOW_HARD_MAX_ENTRIES = 150;
/**
 * Recent entries a manual compress keeps verbatim. The next question usually refers to the
 * last exchange, whose exact wording a summary would blur.
 */
export const EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES = 4;
/** Per-turn DB fetch bound for appending: must exceed what an active group produces between two triggers. */
const EPISODE_APPEND_FETCH_LIMIT = 60;

export type SessionCompression =
  /** The session has no live window, so the next turn starts from a fresh one anyway. */
  | { status: 'no-window' }
  | { status: 'too-short'; entries: number }
  /** A background fold of the same window is in flight. */
  | { status: 'busy' }
  /** The summarizer produced nothing, or the window changed under the fold; nothing was replaced. */
  | { status: 'failed' }
  | { status: 'compressed'; foldedEntries: number; charsBefore: number; charsAfter: number };

/** Chars an entry puts into the prompt: its text plus the reasoning replayed with it. */
function entryChars(entry: ConversationMessageEntry): number {
  return entry.content.length + (entry.reasoning?.length ?? 0);
}

function windowChars(entries: ConversationMessageEntry[]): number {
  return entries.reduce((sum, e) => sum + entryChars(e), 0);
}

/**
 * Manages episode-based conversation history caching.
 * Owns the {@link NormalEpisodeService} instance and a per-episode history Map
 * so the prompt prefix stays stable across turns (improving LLM cache hit rate).
 * Handles new-episode initialization, incremental appending, and scheduling of
 * background compression when the window outgrows its budget.
 */
@singleton()
export class EpisodeCacheManager {
  private readonly episodeService = new NormalEpisodeService();

  /** Per-episode history cache so prompt prefix stays stable until summary roll (for LLM cache). */
  private readonly episodeHistoryCache = new Map<string, ConversationMessageEntry[]>();

  /** Live episode per session, so the previous episode's window is released when the episode rolls over. */
  private readonly activeEpisodeKeyBySession = new Map<string, string>();

  /** Episodes with a compression pass in flight; a second pass would fold an already-folded span. */
  private readonly compressingEpisodeKeys = new Set<string>();

  constructor(@inject(ConversationHistoryService) private conversationHistoryService: ConversationHistoryService) {}

  /**
   * Build history for normal (episode) mode.
   * - SessionId is normalized so history and DB persistence use the same key (group:groupId / user:userId).
   * - New episode (no cache): initial context = last EPISODE_CONTEXT_WINDOW_SIZE (10) messages within 10 min before trigger.
   * - Existing episode (has cache): same start (cached prefix) + new messages from DB since last cached.
   *
   * Never summarizes: see {@link maintainEpisodeContext}.
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
    this.releasePreviousEpisode(canonicalSessionId, episodeKey);
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
        EPISODE_APPEND_FETCH_LIMIT,
      );
      const appended = newMessages.filter((e) => e.messageId !== currentMessageId);
      const combined = [...cached, ...appended];
      entries =
        combined.length > EPISODE_WINDOW_HARD_MAX_ENTRIES ? combined.slice(-EPISODE_WINDOW_HARD_MAX_ENTRIES) : combined;
      if (entries.length < combined.length) {
        logger.warn(
          `[EpisodeCacheManager] Window hit hard max, dropped ${combined.length - entries.length} oldest entries ` +
            `uncompressed | episodeKey=${episodeKey}`,
        );
      }
      this.episodeHistoryCache.set(episodeKey, entries);
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
   * Fold the oldest span of an over-budget window into one summary entry.
   * Called fire-and-forget after the reply completes; the folded window is picked up by the
   * next turn's build, so no turn ever waits on the summarizer.
   */
  async maintainEpisodeContext(episodeKey: string | undefined): Promise<void> {
    if (!episodeKey || this.compressingEpisodeKeys.has(episodeKey)) {
      return;
    }
    const snapshot = this.episodeHistoryCache.get(episodeKey);
    if (!snapshot) {
      return;
    }
    const targetSize = this.planFold(snapshot);
    if (targetSize == null) {
      return;
    }

    this.compressingEpisodeKeys.add(episodeKey);
    try {
      const roll = await this.conversationHistoryService.replaceOldestWithSummary(snapshot, targetSize, new Date());
      // replacedCount 0 means the summarizer yielded nothing. Keep the window intact and retry
      // next turn rather than take the roll's uncompressed trim: the read path's hard max already
      // bounds growth, so there is nothing to buy by dropping the span now.
      if (roll.replacedCount === 0) {
        return;
      }
      this.commitFold(episodeKey, snapshot.slice(0, roll.replacedCount), roll.entries[0]);
    } catch (err) {
      logger.warn('[EpisodeCacheManager] maintainEpisodeContext failed:', err instanceof Error ? err.message : err);
    } finally {
      this.compressingEpisodeKeys.delete(episodeKey);
    }
  }

  /**
   * Decide whether the window is over budget and, if so, how many entries it should have once
   * the oldest span is folded (the summary entry included). Null means leave it alone.
   *
   * The kept tail is walked back-to-front so both budgets land on the same fold: the recent end
   * is what a reply actually needs, and the span that falls off the front is the span the summary
   * then stands for.
   */
  private planFold(entries: ConversationMessageEntry[]): number | null {
    const totalChars = windowChars(entries);
    if (
      entries.length <= EPISODE_WINDOW_COMPRESS_TRIGGER_ENTRIES &&
      totalChars <= EPISODE_WINDOW_COMPRESS_TRIGGER_CHARS
    ) {
      return null;
    }

    let kept = 0;
    let keptChars = 0;
    for (let i = entries.length - 1; i >= 0 && kept < EPISODE_WINDOW_COMPRESS_TARGET_ENTRIES - 1; i--) {
      const withEntry = keptChars + entryChars(entries[i]);
      if (kept >= EPISODE_WINDOW_MIN_RECENT_ENTRIES && withEntry > EPISODE_WINDOW_COMPRESS_TARGET_CHARS) {
        break;
      }
      keptChars = withEntry;
      kept += 1;
    }

    const targetSize = kept + 1;
    return targetSize < entries.length ? targetSize : null;
  }

  /**
   * Write the fold back onto the window as it stands now, not onto the snapshot it was computed
   * from: the read path appends to the same cache while the summarizer runs. The folded span is
   * matched by message id, and a mismatch means the window moved under us (hard-max trim, episode
   * rollover) — dropping the result is correct, the next pass recomputes against the live window.
   */
  private commitFold(
    episodeKey: string,
    foldedSpan: ConversationMessageEntry[],
    summaryEntry: ConversationMessageEntry,
  ): boolean {
    const current = this.episodeHistoryCache.get(episodeKey);
    if (!current || current.length < foldedSpan.length) {
      return false;
    }
    const prefixMatches = foldedSpan.every((entry, i) => current[i].messageId === entry.messageId);
    if (!prefixMatches) {
      logger.debug(`[EpisodeCacheManager] Window moved during compression, discarding fold | episodeKey=${episodeKey}`);
      return false;
    }
    this.episodeHistoryCache.set(episodeKey, [summaryEntry, ...current.slice(foldedSpan.length)]);
    logger.debug(
      `[EpisodeCacheManager] Folded ${foldedSpan.length} entries into summary | ` +
        `episodeKey=${episodeKey} windowSize=${current.length - foldedSpan.length + 1}`,
    );
    return true;
  }

  /**
   * Fold the session's live window now, on request, keeping only the last
   * {@link EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES} entries verbatim. Same fold as the
   * background pass, just not waiting for the window to outgrow its budget.
   */
  async compressSession(sessionId: string, now: Date): Promise<SessionCompression> {
    const episodeKey = this.liveEpisodeKey(sessionId, now);
    const snapshot = episodeKey != null ? this.episodeHistoryCache.get(episodeKey) : undefined;
    if (episodeKey == null || snapshot == null) {
      return { status: 'no-window' };
    }
    const targetSize = EPISODE_COMPRESS_COMMAND_KEEP_ENTRIES + 1;
    if (snapshot.length <= targetSize) {
      return { status: 'too-short', entries: snapshot.length };
    }
    if (this.compressingEpisodeKeys.has(episodeKey)) {
      return { status: 'busy' };
    }

    this.compressingEpisodeKeys.add(episodeKey);
    try {
      const roll = await this.conversationHistoryService.replaceOldestWithSummary(snapshot, targetSize, now);
      if (
        roll.replacedCount === 0 ||
        !this.commitFold(episodeKey, snapshot.slice(0, roll.replacedCount), roll.entries[0])
      ) {
        return { status: 'failed' };
      }
      return {
        status: 'compressed',
        foldedEntries: roll.replacedCount,
        charsBefore: windowChars(snapshot),
        charsAfter: windowChars(roll.entries),
      };
    } finally {
      this.compressingEpisodeKeys.delete(episodeKey);
    }
  }

  /**
   * Drop the session's context and start it again from `at`: the live window empties, and
   * neither it nor any later episode reaches back past that point.
   */
  clearSession(sessionId: string, at: Date): void {
    this.episodeService.moveContextFloor(sessionId, at);
    const episodeKey = this.activeEpisodeKeyBySession.get(sessionId);
    if (episodeKey != null) {
      this.episodeHistoryCache.set(episodeKey, []);
    }
  }

  /** The cached episode the session's next message would continue, if any. */
  private liveEpisodeKey(sessionId: string, now: Date): string | undefined {
    const episodeKey = this.activeEpisodeKeyBySession.get(sessionId);
    const episode = this.episodeService.getLiveEpisode(sessionId, now);
    if (episodeKey == null || episode == null) {
      return undefined;
    }
    return this.episodeService.buildEpisodeKey(sessionId, episode) === episodeKey ? episodeKey : undefined;
  }

  /**
   * Reflect a recall in the session's live window. The window holds DB rows frozen for the
   * provider's prefix cache, and a recall is the one change to an already-cached row it must
   * pick up — otherwise the model reads a withdrawn message as live until the episode ends.
   */
  markRecalled(sessionId: string, messageSeq: number): void {
    const episodeKey = this.activeEpisodeKeyBySession.get(sessionId);
    const window = episodeKey != null ? this.episodeHistoryCache.get(episodeKey) : undefined;
    if (!episodeKey || !window?.some((entry) => entry.messageSeq === messageSeq && !entry.recalled)) {
      return;
    }
    this.episodeHistoryCache.set(
      episodeKey,
      window.map((entry) => (entry.messageSeq === messageSeq ? { ...entry, recalled: true } : entry)),
    );
  }

  /** An episode's window dies with the episode; without this the map grows for the life of the process. */
  private releasePreviousEpisode(sessionId: string, episodeKey: string): void {
    const previousKey = this.activeEpisodeKeyBySession.get(sessionId);
    if (previousKey === episodeKey) {
      return;
    }
    if (previousKey != null) {
      this.episodeHistoryCache.delete(previousKey);
    }
    this.activeEpisodeKeyBySession.set(sessionId, episodeKey);
  }

  private getMessageIdString(context: HookContext): string {
    return String(context.message.id ?? context.message.messageId ?? `msg:${Date.now()}`);
  }
}
