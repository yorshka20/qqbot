// Live2DMemoryExtractionCoordinator — debounced memory extraction for Live2D
// threads. Mirrors MemoryPlugin's flow (debounce per scope → read recent
// entries → format → MemoryExtractService.extractAndUpsert) but sources its
// history from Live2DSessionService and its scope from the synthetic
// Live2D groupId convention (`live2d:<source>[:<scope>]`).
//
// Why this exists:
//   - Main pipeline's MemoryPlugin only watches real QQ group messages via
//     ConversationHistoryService. Live2D threads are ephemeral, scoped by
//     synthetic groupIds, and live in a separate service — the plugin
//     would never see them.
//   - PromptAssemblyStage *reads* memory under these synthetic groupIds
//     but without a write path, `<memory_context>` is permanently empty.
//     This service closes that loop.
//
// Lifecycle:
//   - LLMStage calls `schedule(threadId)` after each successful reply.
//   - A debounce timer (`avatar.memoryExtraction.debounceMs`, default 10 min)
//     collapses bursts of activity into one extract run per idle window.
//   - On fire: read thread entries via Live2DSessionService → filter out
//     bot replies → enforce `minUserEntries` → format as text (same format
//     ConversationHistoryService uses, so the extract LLM sees familiar
//     input) → MemoryExtractService.extractAndUpsert (itself internally
//     queued, so backpressure is handled).
//
// Failure modes are logged and swallowed: memory extraction is strictly
// best-effort background work, never blocks the reply path.

import { mergeAvatarConfig } from '@qqbot/avatar';
import { inject, injectable, singleton } from 'tsyringe';
import { formatConversationEntriesToText } from '@/conversation/history/format';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { MemoryExtractService } from '@/memory';
import { logger } from '@/utils/logger';
import type { AvatarSessionService } from './AvatarSessionService';
import type { Live2DSource } from './types';

interface ScheduleEntry {
  timer: ReturnType<typeof setTimeout>;
  /**
   * Cached groupId at schedule time. The thread's groupId should be stable
   * for its lifetime, but caching at schedule-time avoids a second lookup
   * when the timer fires (and avoids the thread having been evicted in
   * between from some compression/cleanup pass).
   */
  groupId: string;
}

interface ResolvedConfig {
  enabled: boolean;
  debounceMs: number;
  maxEntries: number;
  minUserEntries: number;
  /**
   * Live2D sources whose threads are eligible for extraction. Sourced
   * from `avatar.memoryExtraction.allowedSources`; the default excludes
   * `avatar-cmd` and `livemode-private-batch` (both are dev/test inputs).
   */
  allowedSources: ReadonlySet<string>;
  /** Provider override from avatar.memoryExtraction.provider, else undefined. */
  providerOverride: string | undefined;
}

@injectable()
@singleton()
export class AvatarMemoryExtractionCoordinator {
  private readonly timersByThread = new Map<string, ScheduleEntry>();

  constructor(
    @inject(DITokens.CONFIG) private readonly config: Config,
    @inject(DITokens.AVATAR_SESSION_SERVICE) private readonly sessionService: AvatarSessionService,
  ) {}

  /**
   * Queue a debounced extract run for this thread. Safe to call on every
   * reply — bursts are collapsed. No-op when:
   *   - `avatar.memoryExtraction.enabled` is false
   *   - `source` is not in `avatar.memoryExtraction.allowedSources` (by
   *     default only `bilibili-danmaku-batch` is eligible — `/avatar` and
   *     `/livemode` are dev/test input and intentionally excluded)
   *   - the thread has no resolvable groupId
   */
  schedule(threadId: string, source: Live2DSource): void {
    const resolved = this.resolveConfig();
    if (!resolved.enabled) return;

    if (!resolved.allowedSources.has(source)) {
      // Intentionally silent at info-level: the `/avatar` path hits this on
      // every reply, so noisy logs would flood. Debug is enough to confirm
      // the wiring when troubleshooting.
      logger.debug(
        `[Live2DMemoryExtraction] schedule skipped: source=${source} not in allowlist (${Array.from(resolved.allowedSources).join(',') || '-'})`,
      );
      return;
    }

    const groupId = this.sessionService.getGroupId(threadId);
    if (!groupId) {
      logger.debug(`[Live2DMemoryExtraction] schedule skipped: no groupId for thread=${threadId}`);
      return;
    }

    const existing = this.timersByThread.get(threadId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.timersByThread.delete(threadId);
      // Never let a background extract crash propagate into the Node
      // unhandled-rejection path — this is best-effort maintenance work.
      void this.runExtract(threadId, groupId).catch((err) => {
        logger.error(`[Live2DMemoryExtraction] extract run failed (thread=${threadId} group=${groupId}):`, err);
      });
    }, resolved.debounceMs);
    // Node accepts .unref(); browser/test shims may not — guard it.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    this.timersByThread.set(threadId, { timer, groupId });
  }

  /**
   * Cancel any pending timer for this thread. Used when the thread is
   * closed, or in tests to guarantee deterministic teardown.
   */
  cancel(threadId: string): void {
    const existing = this.timersByThread.get(threadId);
    if (existing) {
      clearTimeout(existing.timer);
      this.timersByThread.delete(threadId);
    }
  }

  /**
   * Drain all pending timers. Called from shutdown paths / tests. Does NOT
   * force-run pending extracts — extraction is lossy by design (next
   * startup's first debounce will pick up from current thread state).
   */
  cancelAll(): void {
    for (const { timer } of this.timersByThread.values()) {
      clearTimeout(timer);
    }
    this.timersByThread.clear();
  }

  /**
   * Force-run extract for a thread immediately (bypassing debounce). Public
   * so /memory-style commands or tests can trigger extraction on demand.
   * Still respects `enabled` + `allowedSources` — the allowlist is a safety
   * fence against accidentally writing test traffic into long-term memory,
   * and an admin who *really* wants to override it can widen the allowlist
   * in config rather than have a different code path bypass it.
   */
  async runNow(threadId: string, source: Live2DSource): Promise<void> {
    const resolved = this.resolveConfig();
    if (!resolved.enabled) return;
    if (!resolved.allowedSources.has(source)) return;
    const groupId = this.sessionService.getGroupId(threadId);
    if (!groupId) return;
    this.cancel(threadId);
    await this.runExtract(threadId, groupId);
  }

  private async runExtract(threadId: string, groupId: string): Promise<void> {
    const resolved = this.resolveConfig();
    // Re-check enabled on fire — config could have been hot-reloaded in
    // the debounce window. Extraction on disabled config would be silent
    // waste of tokens.
    if (!resolved.enabled) return;

    const extractService = this.resolveExtractService();
    if (!extractService) {
      logger.debug('[Live2DMemoryExtraction] MemoryExtractService unavailable, skipping run');
      return;
    }

    const entries = this.sessionService.getHistoryEntries(threadId);
    // Only drop bot replies for extract input — the extract LLM learns
    // facts from what *users* said. Keeping bot turns just pollutes the
    // extraction with self-referential roleplay lines.
    const userOnly = entries.filter((e) => !e.isBotReply);
    if (userOnly.length < resolved.minUserEntries) {
      logger.debug(
        `[Live2DMemoryExtraction] thread=${threadId} group=${groupId}: userEntries=${userOnly.length} < min=${resolved.minUserEntries}, skip`,
      );
      return;
    }

    // Cap by maxEntries (keep the MOST RECENT ones — the tail is what the
    // user has been saying lately and what memory should reflect).
    const cappedEntries = entries.length > resolved.maxEntries ? entries.slice(-resolved.maxEntries) : entries;
    const recentMessagesText = formatConversationEntriesToText(cappedEntries);
    if (!recentMessagesText.trim()) return;

    const provider = this.resolveProvider(resolved);
    logger.info(
      `[Live2DMemoryExtraction] run | thread=${threadId} group=${groupId} provider=${provider} entries=${cappedEntries.length} userEntries=${userOnly.length}`,
    );

    try {
      await extractService.extractAndUpsert(groupId, recentMessagesText, { provider });
    } catch (err) {
      logger.warn(`[Live2DMemoryExtraction] extractAndUpsert failed (thread=${threadId} group=${groupId}):`, err);
    }
  }

  /**
   * Lazily resolve MemoryExtractService from the container. Kept lazy so
   * tests that don't register it (e.g. the live2d stage test) can still
   * exercise the coordinator — it just becomes a no-op in that case.
   */
  private resolveExtractService(): MemoryExtractService | undefined {
    try {
      const container = getContainer();
      if (!container.isRegistered(DITokens.MEMORY_EXTRACT_SERVICE)) {
        return undefined;
      }
      return container.resolve<MemoryExtractService>(DITokens.MEMORY_EXTRACT_SERVICE);
    } catch (err) {
      logger.debug('[Live2DMemoryExtraction] resolveExtractService failed (non-fatal):', err);
      return undefined;
    }
  }

  /**
   * Merge raw avatar config through the shared `mergeAvatarConfig` so the
   * coordinator sees the same defaults/validation as every other consumer
   * of avatar config (LLMStage, PromptAssemblyStage, AvatarService).
   */
  private resolveConfig(): ResolvedConfig {
    const raw = this.config.getAvatarConfig() as Record<string, unknown> | undefined;
    const merged = mergeAvatarConfig(raw);
    const cfg = merged.memoryExtraction;
    return {
      enabled: cfg.enabled,
      debounceMs: cfg.debounceMs,
      maxEntries: cfg.maxEntries,
      minUserEntries: cfg.minUserEntries,
      allowedSources: new Set(cfg.allowedSources),
      providerOverride: cfg.provider,
    };
  }

  /**
   * Provider precedence (most specific first):
   *   1. `avatar.memoryExtraction.provider` (explicit opt-in, scope-specific)
   *   2. `ai.taskProviders.memoryExtract` (system-wide extract provider)
   *   3. `avatar.llmProvider` (whatever the avatar uses for its own replies)
   *   4. `ai.defaultProviders.llm` (last resort)
   */
  private resolveProvider(resolved: ResolvedConfig): string {
    if (resolved.providerOverride) return resolved.providerOverride;

    const aiConfig = this.config.getAIConfig();
    const taskProvider = aiConfig?.taskProviders?.memoryExtract;
    if (typeof taskProvider === 'string' && taskProvider.trim().length > 0) {
      return taskProvider.trim();
    }

    const rawAvatar = this.config.getAvatarConfig() as Record<string, unknown> | undefined;
    const avatarProvider = rawAvatar?.llmProvider;
    if (typeof avatarProvider === 'string' && avatarProvider.trim().length > 0) {
      return avatarProvider.trim();
    }

    return aiConfig?.defaultProviders?.llm ?? 'deepseek';
  }
}
