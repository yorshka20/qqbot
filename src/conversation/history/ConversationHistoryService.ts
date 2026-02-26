// Conversation History Service - single implementation for loading history from DB and formatting (User<userId:nickname> / Assistant)

import type { ThreadService } from '@/conversation/thread';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { formatConversationEntriesToText } from './format';

export interface ConversationMessageEntry {
  /** Stable message ID from database (Message.id). Used for dedup boundary tracking. */
  messageId: string;
  userId: number;
  nickname?: string;
  content: string;
  isBotReply: boolean;
  createdAt: Date;
  /** True when message was @ bot (direct reply already sent); used to mark in thread context. */
  wasAtBot?: boolean;
}

/**
 * Conversation History Service
 * Single module for: loading recent messages from DB (group or any session), formatting with User<userId:nickname> / Assistant,
 * and building conversation history string for prompt (thread first, then in-memory, then DB fallback).
 */
export class ConversationHistoryService {
  constructor(
    private databaseManager: DatabaseManager,
    private defaultLimit = 30,
    private maxHistoryMessages = 10,
  ) {}

  /**
   * Get last N messages for a group (from DB).
   * Uses sessionId format "group:{groupId}" to match ConversationManager / DatabasePersistenceSystem.
   */
  async getRecentMessages(groupId: string | number, limit?: number): Promise<ConversationMessageEntry[]> {
    const sessionId =
      typeof groupId === 'number' ? `group:${groupId}` : groupId.startsWith('group:') ? groupId : `group:${groupId}`;
    return this.getRecentMessagesForSession(sessionId, 'group', limit ?? this.defaultLimit);
  }

  /**
   * Get last N messages for any session (group or user) from DB.
   */
  async getRecentMessagesForSession(
    sessionId: string,
    sessionType: 'group' | 'user',
    limit?: number,
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const take = limit ?? this.defaultLimit;

    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId: String(sessionId),
        sessionType,
      });
      if (!conversation) {
        return [];
      }

      const messages = adapter.getModel('messages');
      const recent = await messages.find(
        { conversationId: conversation.id },
        { orderBy: 'createdAt', order: 'desc', limit: take },
      );
      const chronological = recent.reverse();

      return chronological.map((msg) => this.mapMessageToEntry(msg));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] Failed to load session history:', err);
      return [];
    }
  }

  /**
   * Get all messages for a user in a group conversation (from DB), sorted by createdAt ascending.
   * Used by MemoryPlugin for cold start and full-history user extract.
   */
  async getMessagesForUserInGroup(
    groupId: string,
    userId: string,
    options?: { limit?: number },
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const sessionId = groupId.startsWith('group:') ? groupId : `group:${groupId}`;

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
      const userIdNum = Number(userId);
      const list = await messages.find({
        conversationId: conversation.id,
        userId: Number.isNaN(userIdNum) ? userId : userIdNum,
      } as Partial<Message>);
      const sorted = (list as Message[]).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const slice = options?.limit ? sorted.slice(-options.limit) : sorted;
      return slice.map((msg) => this.mapMessageToEntry(msg));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] Failed to load user messages in group:', err);
      return [];
    }
  }

  /**
   * Get distinct user IDs in a group conversation (from DB). Optionally exclude one (e.g. bot self).
   * Used by MemoryPlugin for cold start user list.
   */
  async getUserIdsInGroup(groupId: string, excludeUserId?: string): Promise<string[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const sessionId = groupId.startsWith('group:') ? groupId : `group:${groupId}`;

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
      const userIds = new Set<string>();
      for (const msg of all as Message[]) {
        userIds.add(String(msg.userId));
      }
      if (excludeUserId != null && excludeUserId !== '') {
        userIds.delete(excludeUserId);
      }
      return Array.from(userIds);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] Failed to get user IDs in group:', err);
      return [];
    }
  }

  /**
   * Get messages for a group with createdAt >= since (for incremental extract; survives bot restart when since is persisted).
   */
  async getMessagesSince(groupId: string | number, since: Date, maxLimit = 2000): Promise<ConversationMessageEntry[]> {
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

      return slice.map((msg) => this.mapMessageToEntry(msg));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] Failed to load messages since:', err);
      return [];
    }
  }

  /** Map DB Message to ConversationMessageEntry. */
  private mapMessageToEntry(msg: Message): ConversationMessageEntry {
    const meta = msg.metadata ?? {};
    const sender = meta.sender;
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
  }

  /**
   * Format message entries as a single text (e.g. for Ollama input).
   * User prefix is unified as User<userId:nickname> (nickname omitted when empty). Bot lines use Assistant.
   * Each line includes [id:index], simple time (M/d HH:mm), and content so the AI can reference ids and judge time gaps.
   */
  formatAsText(entries: ConversationMessageEntry[]): string {
    return formatConversationEntriesToText(entries);
  }

  /**
   * Build conversation history for prompt.
   * Uses thread context when in proactive thread; then in-memory context.context.history; then DB fallback with same format.
   */
  async buildConversationHistory(context: HookContext): Promise<string> {
    const proactiveThreadId = context.metadata.get('proactiveThreadId');
    if (proactiveThreadId) {
      const container = getContainer();
      if (container.isRegistered(DITokens.THREAD_SERVICE)) {
        const threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
        const text = threadService.getContextFormatted(proactiveThreadId);
        if (text) {
          return text;
        }
      }
    }

    const inMemoryHistory = context.context?.history || [];
    if (inMemoryHistory.length > 0) {
      const limited = inMemoryHistory.slice(-this.maxHistoryMessages);
      const userId = context.context?.userId ?? 0;
      const entries: ConversationMessageEntry[] = limited.map((msg, i) => ({
        messageId: `mem:${i}`,
        userId: msg.role === 'user' ? userId : 0,
        nickname: undefined,
        content: msg.content,
        isBotReply: msg.role === 'assistant',
        createdAt: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp ?? Date.now()),
        wasAtBot: undefined,
      }));
      return this.formatAsText(entries);
    }

    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    if (sessionId != null && sessionType != null) {
      const limit = this.maxHistoryMessages * 2;
      const entries = await this.getRecentMessagesForSession(String(sessionId), sessionType as 'group' | 'user', limit);
      if (entries.length > 0) {
        logger.debug(`[ConversationHistoryService] Loaded ${entries.length} messages from DB for session ${sessionId}`);
        return this.formatAsText(entries);
      }
    }

    return '';
  }
}
