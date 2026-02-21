// Thread Service - in-memory threads per group (Phase 1 single; Phase 3 multiple per group)

import { logger } from '@/utils/logger';
import { randomUUID } from 'node:crypto';
import type { GroupMessageEntry } from './GroupHistoryService';

/**
 * Whether content is readable text for thread/analysis context.
 * Skips empty and non-text-only messages (record, image, video, file, etc.) so they are not included in thread or analysis.
 * Exported for use when building analysis input (ProactiveConversationService).
 */
export function isReadableTextForThread(content: string): boolean {
  const t = content.trim();
  if (t === '') return false;
  // Skip content that is only media/placeholder (e.g. [Image:...], [Record:5s], [Video:...], [File:...])
  const onlyPlaceholders = /^(\s*\[(Image|Record|Video|File|Forward|MarketFace|LightApp|XML)(:[^\]]*)?\]\s*)+$/i.test(t);
  return !onlyPlaceholders;
}

export interface ThreadMessage {
  userId: number;
  content: string;
  isBotReply: boolean;
  createdAt: Date;
  /** When true, content is a summary of earlier messages (Phase 4 compression). */
  isSummary?: boolean;
  /** When true, message was @ bot (already replied); shown in thread context for analysis. */
  wasAtBot?: boolean;
}

export interface ProactiveThread {
  threadId: string;
  groupId: string;
  preferenceKey: string;
  messages: ThreadMessage[];
  createdAt: Date;
  lastActivityAt: Date;
}

/**
 * Thread Service (Phase 3: multiple active threads per group)
 * In-memory; same group can have multiple active threads. Reply context uses "current" thread per group.
 */
export class ThreadService {
  /** groupId -> list of active threads (order: oldest first) */
  private threadsByGroup = new Map<string, ProactiveThread[]>();
  /** groupId -> threadId used for reply context when user sends a message (selected thread) */
  private currentThreadIdByGroup = new Map<string, string>();
  /** threadId -> thread (for fast lookup by id) */
  private threadById = new Map<string, ProactiveThread>();

  /**
   * Create a new thread with initial context (recent messages).
   * Does not replace existing threads; group can have multiple threads.
   */
  create(groupId: string, preferenceKey: string, initialMessages: GroupMessageEntry[]): ProactiveThread {
    const threadId = randomUUID();
    const now = new Date();
    const messages: ThreadMessage[] = initialMessages
      .filter((m) => isReadableTextForThread(m.content))
      .map((m) => ({
      userId: m.userId,
      content: m.content,
      isBotReply: m.isBotReply,
      createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
      wasAtBot: m.wasAtBot === true,
    }));

    const thread: ProactiveThread = {
      threadId,
      groupId,
      preferenceKey,
      messages,
      createdAt: now,
      lastActivityAt: now,
    };

    this.threadById.set(threadId, thread);
    const list = this.threadsByGroup.get(groupId) ?? [];
    list.push(thread);
    this.threadsByGroup.set(groupId, list);
    this.currentThreadIdByGroup.set(groupId, threadId);
    logger.info(`[ThreadService] Created thread | threadId=${threadId} | groupId=${groupId} | preferenceKey=${preferenceKey}`);
    return thread;
  }

  /**
   * Get all active threads for a group (Phase 3 multi-thread).
   */
  getActiveThreads(groupId: string): ProactiveThread[] {
    return this.threadsByGroup.get(groupId) ?? [];
  }

  /**
   * Get the "current" thread for reply context (e.g. last replied-in thread), or first active if none set.
   */
  getActiveThread(groupId: string): ProactiveThread | null {
    const currentId = this.currentThreadIdByGroup.get(groupId);
    if (currentId) {
      const t = this.threadById.get(currentId);
      if (t) return t;
    }
    const list = this.threadsByGroup.get(groupId);
    return list?.[0] ?? null;
  }

  /**
   * Set which thread is current for this group (used for reply context when user sends message).
   */
  setCurrentThread(groupId: string, threadId: string): void {
    if (this.threadById.has(threadId)) {
      this.currentThreadIdByGroup.set(groupId, threadId);
    }
  }

  /**
   * Get current thread id for group (for metadata proactiveThreadId).
   */
  getCurrentThreadId(groupId: string): string | null {
    const id = this.currentThreadIdByGroup.get(groupId);
    if (id && this.threadById.has(id)) return id;
    const list = this.threadsByGroup.get(groupId);
    return list?.[0]?.threadId ?? null;
  }

  /**
   * Check if the group has at least one active thread.
   */
  hasActiveThread(groupId: string): boolean {
    return (this.threadsByGroup.get(groupId)?.length ?? 0) > 0;
  }

  /**
   * Append a message to the thread and update lastActivityAt.
   */
  appendMessage(threadId: string, entry: { userId: number; content: string; isBotReply: boolean }): void {
    const thread = this.threadById.get(threadId);
    if (!thread) {
      logger.warn(`[ThreadService] Append failed: thread not found | threadId=${threadId}`);
      return;
    }
    const now = new Date();
    thread.messages.push({
      userId: entry.userId,
      content: entry.content,
      isBotReply: entry.isBotReply,
      createdAt: now,
    });
    thread.lastActivityAt = now;
  }

  /**
   * Append group messages to the thread.
   * messageIds: indices (0-based) into entries; only those entries are appended, in chronological order.
   * When messageIds is missing or empty, nothing is appended.
   */
  appendGroupMessages(
    threadId: string,
    entries: GroupMessageEntry[],
    options?: { messageIds?: string[] },
  ): void {
    const thread = this.threadById.get(threadId);
    if (!thread) return;
    const rawIds = options?.messageIds;
    if (!rawIds?.length) return;
    const indices = rawIds
      .map((id) => parseInt(id, 10))
      .filter((i) => !Number.isNaN(i) && i >= 0 && i < entries.length);
    const unique = [...new Set(indices)].sort((a, b) => a - b);
    const toAppend = unique.map((i) => entries[i]);
    for (const e of toAppend) {
      if (!isReadableTextForThread(e.content)) continue;
      thread.messages.push({
        userId: e.userId,
        content: e.content,
        isBotReply: e.isBotReply,
        createdAt: e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt),
        wasAtBot: e.wasAtBot === true,
      });
      thread.lastActivityAt =
        e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
    }
  }

  /**
   * Get thread context as formatted text (for prompts).
   * Summary messages (Phase 4) are rendered as "[Summary of earlier messages]: ...".
   * User messages that were @ bot are marked with [用户@机器人，已针对性回复] so analysis can skip them.
   */
  getContextFormatted(threadId: string): string {
    const thread = this.threadById.get(threadId);
    if (!thread) return '';
    return thread.messages
      .map((m) => {
        if (m.isSummary) {
          return `[Summary of earlier messages]: ${m.content}`;
        }
        const who = m.isBotReply ? 'Assistant' : `User<${m.userId}>`;
        const atBotMark = !m.isBotReply && m.wasAtBot ? ' [用户@机器人，已针对性回复]' : '';
        return `${m.createdAt.toLocaleTimeString()} ${who}: ${m.content}${atBotMark}`;
      })
      .join('\n');
  }

  /**
   * Get thread context with [id:index] prefix per line for LLM topic-cleaning (output keepIndices).
   * User messages that were @ bot are marked with [用户@机器人，已针对性回复].
   */
  getContextFormattedWithIndices(threadId: string): string {
    const thread = this.threadById.get(threadId);
    if (!thread) return '';
    return thread.messages
      .map((m, i) => {
        if (m.isSummary) {
          return `[id:${i}] [Summary of earlier messages]: ${m.content}`;
        }
        const who = m.isBotReply ? 'Assistant' : `User<${m.userId}>`;
        const atBotMark = !m.isBotReply && m.wasAtBot ? ' [用户@机器人，已针对性回复]' : '';
        return `[id:${i}] ${m.createdAt.toLocaleTimeString()} ${who}: ${m.content}${atBotMark}`;
      })
      .join('\n');
  }

  /**
   * Keep only messages at the given indices (for topic cleaning). Order preserved. Invalid indices skipped.
   * Does nothing if thread not found or indices would leave thread empty (safety).
   */
  keepOnlyMessageIndices(threadId: string, indices: number[]): void {
    const thread = this.threadById.get(threadId);
    if (!thread) return;
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < thread.messages.length).sort((a, b) => a - b);
    if (sorted.length === 0) return;
    const kept = sorted.map((i) => thread.messages[i]);
    thread.messages.length = 0;
    thread.messages.push(...kept);
    const last = kept[kept.length - 1];
    thread.lastActivityAt = last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt);
    logger.info(`[ThreadService] Kept ${kept.length} messages (topic clean) | threadId=${threadId}`);
  }

  /**
   * Replace the earliest N messages with a single summary message (Phase 4 compression).
   * Does nothing if thread not found or numToReplace is invalid.
   */
  replaceEarliestWithSummary(threadId: string, numToReplace: number, summaryText: string): void {
    const thread = this.threadById.get(threadId);
    if (!thread || numToReplace <= 0 || numToReplace > thread.messages.length) {
      if (thread && (numToReplace <= 0 || numToReplace > thread.messages.length)) {
        logger.warn(
          `[ThreadService] replaceEarliestWithSummary skipped | threadId=${threadId} | numToReplace=${numToReplace} | messagesLength=${thread.messages.length}`,
        );
      }
      return;
    }
    const now = new Date();
    const summaryMessage: ThreadMessage = {
      userId: 0,
      content: summaryText,
      isBotReply: false,
      createdAt: now,
      isSummary: true,
    };
    thread.messages.splice(0, numToReplace, summaryMessage);
    thread.lastActivityAt = now;
    logger.info(`[ThreadService] Replaced earliest ${numToReplace} messages with summary | threadId=${threadId}`);
  }

  /**
   * Get thread by id (for reply path when we have threadId in metadata).
   */
  getThread(threadId: string): ProactiveThread | null {
    return this.threadById.get(threadId) ?? null;
  }

  /**
   * End a thread (remove from active). Updates current thread if needed.
   */
  endThread(threadId: string): void {
    const thread = this.threadById.get(threadId);
    if (!thread) return;
    this.threadById.delete(threadId);
    const list = this.threadsByGroup.get(thread.groupId);
    if (list) {
      const idx = list.findIndex((t) => t.threadId === threadId);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) {
        this.threadsByGroup.delete(thread.groupId);
        this.currentThreadIdByGroup.delete(thread.groupId);
      } else if (this.currentThreadIdByGroup.get(thread.groupId) === threadId) {
        this.currentThreadIdByGroup.set(thread.groupId, list[0].threadId);
      }
    }
    logger.info(`[ThreadService] Ended thread | threadId=${threadId} | groupId=${thread.groupId}`);
  }
}
