// Conversation History Service - single implementation for loading history from DB and formatting (User<userId:nickname> / Assistant)

import type { SummarizeService } from '@/ai/services/SummarizeService';
import type { ThreadService } from '@/conversation/thread';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Conversation, Message } from '@/database/models/types';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { formatConversationEntriesToText } from './format';

export interface ConversationMessageEntry {
  /** Stable message ID from database (Message.id). Used for dedup boundary tracking. */
  messageId: string;
  userId: number;
  nickname?: string;
  content: string;
  segments?: MessageSegment[];
  isBotReply: boolean;
  createdAt: Date;
  /** True when message was @ bot (direct reply already sent); used to mark in thread context. */
  wasAtBot?: boolean;
}

/**
 * Normalize sessionId to canonical form for DB/history lookup.
 * Ensures group sessions use "group:{groupId}" and user sessions use "user:{userId}" so history and persistence always match.
 */
export function normalizeSessionId(
  sessionId: unknown,
  sessionType: 'group' | 'user',
  fallbackGroupId?: number,
  fallbackUserId?: number,
): string {
  const s = sessionId != null ? String(sessionId).trim() : '';
  if (sessionType === 'group') {
    if (s.startsWith('group:')) {
      return s;
    }
    const id = fallbackGroupId ?? (s ? parseInt(s, 10) : NaN);
    return Number.isNaN(id) ? s || 'group:0' : `group:${id}`;
  }
  if (sessionType === 'user') {
    if (s.startsWith('user:')) {
      return s;
    }
    const id = fallbackUserId ?? (s ? parseInt(s, 10) : NaN);
    return Number.isNaN(id) ? s || 'user:0' : `user:${id}`;
  }
  return s || 'unknown:0';
}

/**
 * Normalize groupId (string "group:123" or raw number) to canonical sessionId and numeric id for DB.
 * Use this at service boundaries so callers can pass either form; no inline ternary elsewhere.
 */
export function normalizeGroupId(groupId: string | number): { sessionId: string; groupIdNum: number } {
  if (typeof groupId === 'number' && !Number.isNaN(groupId)) {
    return { sessionId: `group:${groupId}`, groupIdNum: groupId };
  }
  const s = String(groupId).trim().replace(/^group:/i, '');
  const groupIdNum = parseInt(s, 10) || 0;
  return { sessionId: `group:${groupIdNum}`, groupIdNum };
}

/**
 * Conversation History Service
 * Single module for: loading recent messages from DB (group or any session), formatting with User<userId:nickname> / Assistant,
 * and building conversation history string for prompt (thread first, then in-memory, then DB fallback).
 */
export class ConversationHistoryService {
  private summarizeService: SummarizeService;
  constructor(
    private databaseManager: DatabaseManager,
    private defaultLimit = 30,
    private maxHistoryMessages = 10,
  ) {
    this.summarizeService = getContainer().resolve<SummarizeService>(DITokens.SUMMARIZE_SERVICE);
  }

  /**
   * Get last N messages for a group (from DB).
   * Uses sessionId format "group:{groupId}" to match ConversationManager / DatabasePersistenceSystem.
   */
  async getRecentMessages(groupId: string | number, limit?: number): Promise<ConversationMessageEntry[]> {
    const { sessionId } = normalizeGroupId(groupId);
    return this.getRecentMessagesForSession(sessionId, 'group', limit ?? this.defaultLimit);
  }

  /**
   * Append a bot reply to the group conversation in DB for **non-pipeline** reply paths only (proactive reply, "已结束 thread").
   * Pipeline replies (user @ bot, reply-only) are persisted by DatabasePersistenceSystem in COMPLETE stage; they never call this,
   * so there is no duplicate. Proactive sends do not go through the pipeline, so this is the only place they are written to DB.
   * Stores the given text as message content so that getRecentMessages and analysis see card text, not image placeholder.
   *
   * @param groupId - Group ID (string "group:123" or number); normalized at entry so no inline checks below.
   * @param content - Reply text to store (card text when reply was rendered as card; plain text otherwise)
   * @param options - Optional botUserId (default 0), messageSeq (when provided, e.g. from send response, so reply lookups can find this message)
   */
  async appendBotReplyToGroup(
    groupId: string | number,
    content: string,
    options?: { botUserId?: number; messageSeq?: number },
  ): Promise<void> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return;
    }
    const { sessionId, groupIdNum } = normalizeGroupId(groupId);
    const botUserId = options?.botUserId ?? 0;
    try {
      const conversations = adapter.getModel('conversations');
      let conversation: Conversation | null = await conversations.findOne({
        sessionId,
        sessionType: 'group',
      });
      const now = new Date();
      if (!conversation) {
        conversation = await conversations.create({
          sessionId,
          sessionType: 'group',
          messageCount: 0,
          lastMessageAt: now,
          metadata: {},
        });
      }
      const messages = adapter.getModel('messages');
      const messageSeq = options?.messageSeq;
      await messages.create({
        conversationId: conversation.id,
        userId: botUserId,
        messageType: 'group',
        groupId: groupIdNum,
        content,
        protocol: 'unknown',
        messageSeq,
        metadata: {
          isBotReply: true,
          timestamp: now.toISOString(),
        },
      });
      const messageCount = await messages.count({ conversationId: conversation.id });
      await conversations.update(conversation.id, {
        messageCount,
        lastMessageAt: now,
      });
    } catch (error) {
      const err = error instanceof Error ? error : error;
      logger.warn('[ConversationHistoryService] Failed to append bot reply to group:', err);
    }
  }

  /**
   * Get last N messages for any session (group or user) from DB.
   * When limit is 0, returns all messages (no cap); use for RAG cold start full backfill.
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
    const options: { orderBy: string; order: 'asc' | 'desc'; limit?: number } = {
      orderBy: 'createdAt',
      order: 'desc',
    };
    if (take > 0) {
      options.limit = take;
    }

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
      const recent = await messages.find({ conversationId: conversation.id }, options);
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

    const { sessionId } = normalizeGroupId(groupId);

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

    const { sessionId } = normalizeGroupId(groupId);

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
   * Get all sessions (conversations) from DB for RAG backfill. Returns sessionId and sessionType.
   */
  async getAllSessions(): Promise<Array<{ sessionId: string; sessionType: 'group' | 'user' }>> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }
    try {
      const conversations = adapter.getModel('conversations');
      const all = await conversations.find({}, { orderBy: 'createdAt', order: 'asc' });
      return (all as Conversation[]).map((c) => ({
        sessionId: String(c.sessionId),
        sessionType: c.sessionType as 'group' | 'user',
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('[ConversationHistoryService] Failed to load all sessions:', err);
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

    const { sessionId } = normalizeGroupId(groupId);
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
      segments: this.parseRawSegments(msg.rawContent),
      isBotReply: meta.isBotReply === true,
      createdAt: new Date(msg.createdAt),
      wasAtBot: meta.wasAtBot === true,
    };
  }

  private parseRawSegments(rawContent?: unknown): MessageSegment[] | undefined {
    // DB may return non-string (e.g. auto-parsed JSON); only treat string as rawContent
    if (typeof rawContent !== 'string' || rawContent.trim() === '') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(rawContent) as unknown;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as MessageSegment[];
    } catch {
      return undefined;
    }
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
   * When entries exceed maxEntries, summarize the oldest segment into one assistant entry (summary roll).
   * Resolves SummarizeService from DI when needed; when not registered, oldest entries are dropped (no summary).
   *
   * @param entries - Chronological history entries (oldest first)
   * @param maxEntries - Max entries to keep; when exceeded, oldest are summarized into one
   * @param now - Used for summary entry messageId
   */
  async replaceOldestWithSummary(
    entries: ConversationMessageEntry[],
    maxEntries: number,
    now: Date,
  ): Promise<ConversationMessageEntry[]> {
    if (entries.length <= maxEntries) {
      return entries;
    }
    const numToSummarize = entries.length - (maxEntries - 1);
    const toSummarize = entries.slice(0, numToSummarize);
    const rest = entries.slice(numToSummarize);
    const conversationText = this.formatAsText(toSummarize);
    const summaryText = await this.summarizeService.summarize(conversationText);
    const summaryEntry: ConversationMessageEntry = {
      messageId: `summary:${now.getTime()}`,
      userId: 0,
      content: summaryText.trim() || '[Previous conversation summary]',
      isBotReply: true,
      createdAt: toSummarize[0].createdAt,
    };
    return [summaryEntry, ...rest];
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
        segments: undefined,
        isBotReply: msg.role === 'assistant',
        createdAt: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp ?? Date.now()),
        wasAtBot: undefined,
      }));
      return this.formatAsText(entries);
    }

    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    if (sessionId != null && sessionType != null) {
      const limit = this.maxHistoryMessages;
      const entries = await this.getRecentMessagesForSession(String(sessionId), sessionType as 'group' | 'user', limit);
      if (entries.length > 0) {
        return this.formatAsText(entries);
      }
    }

    return '';
  }

  /**
   * Get session messages after a specific time, sorted by createdAt ascending.
   * Fetches at most maxLimit messages from DB (desc by createdAt) then filters by since, so we never load the full conversation.
   * Uses normalized sessionId so lookup matches DB persistence (group:groupId / user:userId).
   */
  async getMessagesSinceForSession(
    sessionId: string,
    sessionType: 'group' | 'user',
    since: Date,
    maxLimit = 500,
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const canonicalSessionId = normalizeSessionId(sessionId, sessionType);
    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId: canonicalSessionId,
        sessionType,
      });
      if (!conversation) {
        return [];
      }

      const messages = adapter.getModel('messages');
      const sinceTs = since.getTime();
      // Fetch only the last maxLimit messages (most recent first) to avoid loading entire conversation.
      const recent = await messages.find(
        { conversationId: conversation.id },
        { orderBy: 'createdAt', order: 'desc', limit: maxLimit },
      );
      const filtered = (recent as Message[])
        .filter((m) => new Date(m.createdAt).getTime() >= sinceTs)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, maxLimit);

      return filtered.map((m) => this.mapMessageToEntry(m));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] Failed to load session messages since time:', err);
      return [];
    }
  }
}
