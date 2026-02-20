// Group History Service - loads last N messages for a group from DB (for proactive conversation analysis)

import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import { logger } from '@/utils/logger';

export interface GroupMessageEntry {
  userId: number;
  content: string;
  isBotReply: boolean;
  createdAt: Date;
}

/**
 * Group History Service
 * Loads recent messages for a group from the database.
 * Used for Ollama preliminary analysis and for building initial thread context.
 */
export class GroupHistoryService {
  constructor(
    private databaseManager: DatabaseManager,
    private defaultLimit = 30,
  ) { }

  /**
   * Get last N messages for a group (from DB).
   * Returns empty array if DB not connected or no conversation/messages.
   * Uses sessionId format "group:{groupId}" to match ConversationManager / DatabasePersistenceSystem.
   */
  async getRecentMessages(groupId: string | number, limit?: number): Promise<GroupMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const sessionId = `group:${groupId}`;
    const take = limit ?? this.defaultLimit;

    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId,
        sessionType: 'group',
      });
      if (!conversation) {
        return [];
      }

      const messages = adapter.getModel('messages');
      const all = await messages.find({ conversationId: conversation.id });
      const sorted = (all as Message[]).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const recent = sorted.slice(-take);

      return recent.map((msg) => {
        const meta = (msg.metadata as Record<string, unknown>) || {};
        return {
          userId: msg.userId,
          content: msg.content,
          isBotReply: meta.isBotReply === true,
          createdAt: new Date(msg.createdAt),
        };
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[GroupHistoryService] Failed to load group history:', err);
      return [];
    }
  }

  /**
   * Format message entries as a single text (e.g. for Ollama input).
   * Each line includes [id:index], simple time (M/d HH:mm), and content so the AI can reference ids and judge time gaps (e.g. for end-thread).
   */
  formatAsText(entries: GroupMessageEntry[]): string {
    return entries
      .map((e, i) => {
        const who = e.isBotReply ? 'Assistant' : `User<${e.userId}>`;
        const t = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
        const timeStr = this.formatSimpleTime(t);
        return `[id:${i}] ${timeStr} ${who}: ${e.content}`;
      })
      .join('\n');
  }

  /**
   * Same as formatAsText: [id:index], simple time, content. Kept for naming clarity where indices are used for messageIds.
   */
  formatAsTextWithIds(entries: GroupMessageEntry[]): string {
    return this.formatAsText(entries);
  }

  /** Simple time for AI to judge intervals (e.g. long gap → end thread). */
  private formatSimpleTime(d: Date): string {
    const M = d.getMonth() + 1;
    const day = d.getDate();
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${M}/${day} ${h}:${m}`;
  }
}
