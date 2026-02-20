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
  ) {}

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
   */
  formatAsText(entries: GroupMessageEntry[]): string {
    return entries
      .map((e) => {
        const who = e.isBotReply ? 'Assistant' : `User${e.userId}`;
        return `${who}: ${e.content}`;
      })
      .join('\n');
  }
}
