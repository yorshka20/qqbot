// Thread Service - in-memory thread per group (Phase 1: one thread per group)

import { logger } from '@/utils/logger';
import { randomUUID } from 'node:crypto';
import type { GroupMessageEntry } from './GroupHistoryService';

export interface ThreadMessage {
  userId: number;
  content: string;
  isBotReply: boolean;
  createdAt: Date;
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
 * Thread Service (Phase 1)
 * In-memory, at most one active thread per group.
 * Used to scope proactive participation and to provide thread context for replies.
 */
export class ThreadService {
  /** groupId -> active thread */
  private threadsByGroup = new Map<string, ProactiveThread>();

  /**
   * Create a new thread with initial context (recent messages).
   * If the group already has an active thread, it is replaced.
   */
  create(groupId: string, preferenceKey: string, initialMessages: GroupMessageEntry[]): ProactiveThread {
    const threadId = randomUUID();
    const now = new Date();
    const messages: ThreadMessage[] = initialMessages.map((m) => ({
      userId: m.userId,
      content: m.content,
      isBotReply: m.isBotReply,
      createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
    }));

    const thread: ProactiveThread = {
      threadId,
      groupId,
      preferenceKey,
      messages,
      createdAt: now,
      lastActivityAt: now,
    };

    this.threadsByGroup.set(groupId, thread);
    logger.info(`[ThreadService] Created thread | threadId=${threadId} | groupId=${groupId} | preferenceKey=${preferenceKey}`);
    return thread;
  }

  /**
   * Get the active thread for a group, if any.
   */
  getActiveThread(groupId: string): ProactiveThread | null {
    return this.threadsByGroup.get(groupId) ?? null;
  }

  /**
   * Check if the group has an active thread.
   */
  hasActiveThread(groupId: string): boolean {
    return this.threadsByGroup.has(groupId);
  }

  /**
   * Append a message to the thread and update lastActivityAt.
   */
  appendMessage(threadId: string, entry: { userId: number; content: string; isBotReply: boolean }): void {
    const thread = Array.from(this.threadsByGroup.values()).find((t) => t.threadId === threadId);
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
   * Get thread context as formatted text (for prompts).
   */
  getContextFormatted(threadId: string): string {
    const thread = Array.from(this.threadsByGroup.values()).find((t) => t.threadId === threadId);
    if (!thread) return '';
    return thread.messages
      .map((m) => {
        const who = m.isBotReply ? 'Assistant' : `User[${m.userId}]`;
        return `${m.createdAt.toLocaleTimeString()} ${who}: ${m.content}`;
      })
      .join('\n');
  }

  /**
   * Get thread by id (for reply path when we have threadId in metadata).
   */
  getThread(threadId: string): ProactiveThread | null {
    return Array.from(this.threadsByGroup.values()).find((t) => t.threadId === threadId) ?? null;
  }

  /**
   * End a thread (remove from active). Phase 1: optional; used when we add lifecycle later.
   */
  endThread(threadId: string): void {
    const thread = Array.from(this.threadsByGroup.values()).find((t) => t.threadId === threadId);
    if (thread) {
      this.threadsByGroup.delete(thread.groupId);
      logger.info(`[ThreadService] Ended thread | threadId=${threadId} | groupId=${thread.groupId}`);
    }
  }
}
