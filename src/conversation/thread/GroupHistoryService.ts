// Group History Service - loads last N messages for a group from DB (for proactive conversation analysis)

import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import { logger } from '@/utils/logger';

export interface GroupMessageEntry {
  /** Stable message ID from database (Message.id). Used for dedup boundary tracking. */
  messageId: string;
  userId: number;
  /** Sender display name (from protocol: nickname or card). */
  nickname?: string;
  content: string;
  isBotReply: boolean;
  createdAt: Date;
  /** True when message was @ bot (direct reply already sent); used to mark in thread context. */
  wasAtBot?: boolean;
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
      const recent = (await messages.find(
        { conversationId: conversation.id },
        { orderBy: 'createdAt', order: 'desc', limit: take },
      )) as Message[];
      const chronological = recent.reverse();

      return chronological.map((msg) => {
        const meta = (msg.metadata as Record<string, unknown>) || {};
        const sender = meta.sender as { nickname?: string; card?: string } | undefined;
        const nickname = sender?.nickname ?? sender?.card;
        return {
          messageId: msg.id,
          userId: msg.userId,
          nickname: typeof nickname === 'string' ? nickname : undefined,
          content: msg.content,
          isBotReply: meta.isBotReply === true,
          createdAt: new Date(msg.createdAt),
          wasAtBot: meta.wasAtBot === true,
        };
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[GroupHistoryService] Failed to load group history:', err);
      return [];
    }
  }

  /**
   * Get messages for a group with createdAt >= since (for incremental extract; survives bot restart when since is persisted).
   * Returns empty if no conversation or no messages. Capped at maxLimit to avoid huge payloads.
   */
  async getMessagesSince(
    groupId: string | number,
    since: Date,
    maxLimit = 2000,
  ): Promise<GroupMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const sessionId = `group:${groupId}`;
    const sinceTime = since.getTime();

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
      const sorted = (all as Message[])
        .filter((m) => new Date(m.createdAt).getTime() >= sinceTime)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const slice = sorted.slice(0, maxLimit);

      return slice.map((msg) => {
        const meta = (msg.metadata as Record<string, unknown>) || {};
        const sender = meta.sender as { nickname?: string; card?: string } | undefined;
        const nickname = sender?.nickname ?? sender?.card;
        return {
          messageId: msg.id,
          userId: msg.userId,
          nickname: typeof nickname === 'string' ? nickname : undefined,
          content: msg.content,
          isBotReply: meta.isBotReply === true,
          createdAt: new Date(msg.createdAt),
          wasAtBot: meta.wasAtBot === true,
        };
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[GroupHistoryService] Failed to load messages since:', err);
      return [];
    }
  }

  /**
   * Format message entries as a single text (e.g. for Ollama input).
   * User prefix is unified as User<userId:nickname> (nickname omitted when empty). Bot lines use Assistant.
   * Each line includes [id:index], simple time (M/d HH:mm), and content so the AI can reference ids and judge time gaps.
   */
  formatAsText(entries: GroupMessageEntry[]): string {
    return entries
      .map((e, i) => {
        const who = e.isBotReply
          ? 'Assistant'
          : `User<${e.userId}${e.nickname != null && e.nickname !== '' ? ':' + e.nickname : ''}>`;
        const t = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
        const timeStr = this.formatSimpleTime(t);
        const atBotMark = !e.isBotReply && e.wasAtBot ? ' [用户@机器人，已针对性回复]' : '';
        return `[id:${i}] ${timeStr} ${who}: ${e.content}${atBotMark}`;
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
