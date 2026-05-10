// Live2DSessionService — owns the rolling conversation session used by the
// Live2D pipeline. Each "scope" (avatar-cmd, bilibili-live, livemode-per-user)
// is backed by a single persistent ThreadService thread so history + memory +
// async compression behave the same as the main conversation flow.
//
// Design choices:
//   - `avatar-cmd` is treated as a single GLOBAL thread by design — the user
//     uses it as an admin-style probe from any chat, continuity > fidelity.
//   - `bilibili-danmaku-batch` is per-room (one thread per live room). Today
//     the bot only connects to one room at a time, so the scope collapses to
//     a single thread; when multi-room support lands, passing the roomId as
//     `scope` keeps threads separate.
//   - Other sources (e.g. future `livemode-private-batch`) follow the pattern
//     `live2d:<source>:<scope>`.
//
// Topic cleaning is intentionally bypassed: Live2D scopes don't ship a
// `${preferenceKey}.summary` template, so the compression service's topic
// pass would error out. We use `scheduleCompressOnly` to run the
// summarize-and-replace pass only.

import { inject, injectable, singleton } from 'tsyringe';
import type { ConversationMessageEntry } from '@/conversation/history';
import type { ThreadContextCompressionService, ThreadService } from '@/conversation/thread';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import type { AvatarSource } from '../types';

/** Fake preferenceKey for Live2D threads. Not used for template rendering. */
const LIVE2D_PREFERENCE_PREFIX = 'live2d';

@injectable()
@singleton()
export class AvatarSessionService {
  constructor(
    @inject(DITokens.THREAD_SERVICE) private threadService: ThreadService,
    @inject(DITokens.THREAD_CONTEXT_COMPRESSION_SERVICE)
    private compressionService: ThreadContextCompressionService,
  ) {}

  /**
   * Resolve (and lazily create) the thread for this source + scope.
   * Returns the thread id. Subsequent calls with the same scope return
   * the same id.
   */
  ensureThread(source: AvatarSource, scope?: string): string {
    const groupId = this.resolveGroupId(source, scope);
    const existingId = this.threadService.getCurrentThreadId(groupId);
    if (existingId) return existingId;
    const thread = this.threadService.create(groupId, `${LIVE2D_PREFERENCE_PREFIX}:${source}`, []);
    logger.debug(
      `[AvatarSessionService] created thread | source=${source} scope=${scope ?? '-'} threadId=${thread.threadId}`,
    );
    return thread.threadId;
  }

  /** Append a user-side message to the thread. */
  appendUserMessage(threadId: string, userId: string | number, content: string): void {
    if (!content.trim()) return;
    this.threadService.appendMessage(threadId, { userId, content, isBotReply: false });
  }

  /** Append the bot's reply to the thread. */
  appendAssistantMessage(threadId: string, content: string): void {
    if (!content.trim()) return;
    this.threadService.appendMessage(threadId, { userId: 0, content, isBotReply: true });
  }

  /**
   * Get the thread's messages in the shape `PromptMessageAssembler` expects.
   * Returns an empty array when the thread is missing or freshly created.
   */
  getHistoryEntries(threadId: string): ConversationMessageEntry[] {
    const thread = this.threadService.getThread(threadId);
    if (!thread) return [];
    return thread.messages.map((m, idx) => ({
      messageId: `live2d:${threadId}:${idx}`,
      userId: m.userId,
      nickname: m.nickname,
      content: m.content,
      segments: undefined,
      isBotReply: m.isBotReply,
      createdAt: m.createdAt,
      wasAtBot: m.wasAtBot,
    }));
  }

  /** Fire async compression-only pass (non-blocking). */
  scheduleCompression(threadId: string): void {
    this.compressionService.scheduleCompressOnly(threadId);
  }

  /**
   * Return the groupId owning this thread, or `undefined` if the thread is
   * missing. Downstream services (memory extraction, memory reads) need a
   * consistent scope key and this is the canonical source of truth.
   */
  getGroupId(threadId: string): string | undefined {
    return this.threadService.getThread(threadId)?.groupId ?? undefined;
  }

  /**
   * Public projection of the synthetic-groupId convention used for Live2D
   * sources. Kept here so the read path (memory lookup in PromptAssemblyStage)
   * and the write path (memory extraction coordinator) share a single
   * derivation rule instead of duplicating it.
   */
  groupIdFor(source: AvatarSource, scope?: string): string {
    return this.resolveGroupId(source, scope);
  }

  private resolveGroupId(source: AvatarSource, scope?: string): string {
    if (source === 'avatar-cmd') return `${LIVE2D_PREFERENCE_PREFIX}:avatar-cmd:global`;
    if (source === 'bilibili-danmaku-batch') {
      return scope ? `${LIVE2D_PREFERENCE_PREFIX}:bilibili-live:${scope}` : `${LIVE2D_PREFERENCE_PREFIX}:bilibili-live`;
    }
    return scope ? `${LIVE2D_PREFERENCE_PREFIX}:${source}:${scope}` : `${LIVE2D_PREFERENCE_PREFIX}:${source}`;
  }
}
