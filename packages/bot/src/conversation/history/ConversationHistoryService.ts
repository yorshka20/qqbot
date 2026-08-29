// Conversation History Service - single implementation for loading history from DB and formatting (User<userId:nickname> / Assistant)

import type { SummarizeService } from '@/ai/services/SummarizeService';
import type { ThreadService } from '@/conversation/thread';
import type { ProtocolName } from '@/core/config/types/protocol';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { SQLiteAdapter } from '@/database/adapters/SQLiteAdapter';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Conversation, Message } from '@/database/models/types';
import type { HookContext } from '@/hooks/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { formatConversationEntriesToText, formatEntriesForSummaryInput } from './format';

export interface ConversationMessageEntry {
  /** Stable message ID from database (Message.id). Used for dedup boundary tracking. */
  messageId: string;
  userId: number | string;
  nickname?: string;
  content: string;
  segments?: MessageSegment[];
  isBotReply: boolean;
  createdAt: Date;
  /** True when message was @ bot (direct reply already sent); used to mark in thread context. */
  wasAtBot?: boolean;
  /**
   * True when this entry stands in for a span of compressed earlier messages rather
   * than something a participant said. Readers that attribute entries to a speaker
   * — prompt serializers, "what did users say" filters — must check this first.
   * Mirrors `ThreadMessage.isSummary` on the thread side.
   */
  isSummary?: boolean;
  /** For summary entries: the span covered. A summary has no single moment of its own. */
  summarySpan?: { from: Date; to: Date };
}

/** Outcome of a summary roll: the resulting window plus how many entries the summary stands for. */
export interface SummaryRollResult {
  entries: ConversationMessageEntry[];
  /** Leading entries folded into the summary entry; 0 when no summary was produced. */
  replacedCount: number;
}

/**
 * Normalize sessionId to canonical form for DB/history lookup.
 * Ensures group sessions use "group:{groupId}" and user sessions use "user:{userId}" so history and persistence always match.
 */
export function normalizeSessionId(
  sessionId: unknown,
  sessionType: 'group' | 'user',
  fallbackGroupId?: number | string,
  fallbackUserId?: number | string,
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
  const s = String(groupId)
    .trim()
    .replace(/^group:/i, '');
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
   * @param protocol - Protocol this message was sent through. Stored on the row so reaction/reply lookups
   *   (which query by the incoming event's protocol, e.g. 'milky') can find this bot message.
   * @param options - Optional botUserId (default 0), messageSeq (when provided, e.g. from send response, so reply lookups can find this message), subtext, replyTags
   */
  async appendBotReplyToGroup(
    groupId: string | number,
    content: string,
    protocol: ProtocolName,
    options?: { botUserId?: number; messageSeq?: number; subtext?: string; replyTags?: string[] },
  ): Promise<void> {
    const { groupIdNum } = normalizeGroupId(groupId);
    await this.appendBotMessageToSession({ sessionType: 'group', targetId: groupIdNum }, content, protocol, options);
  }

  /**
   * Persist one outbound bot message into session history (group or private).
   * Invariant: every message the bot actually delivers to a chat must land in
   * history through this method (or the onMessageSent reply path) — otherwise
   * the next turn's LLM sees a conversation missing its own sent messages and
   * wastes reasoning reconstructing what it said. Callers include the proactive
   * flow and mid-loop sending tools (send_message / generate_image).
   */
  async appendBotMessageToSession(
    target: { sessionType: 'group' | 'user'; targetId: string | number },
    content: string,
    protocol: ProtocolName,
    options?: { botUserId?: number; messageSeq?: number; subtext?: string; replyTags?: string[]; viaTool?: string },
  ): Promise<void> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return;
    }
    const { sessionType } = target;
    const isGroup = sessionType === 'group';
    const targetIdNum = Number(target.targetId);
    const sessionId = isGroup ? normalizeGroupId(target.targetId).sessionId : `user:${targetIdNum}`;
    const botUserId = options?.botUserId ?? 0;
    try {
      const conversations = adapter.getModel('conversations');
      let conversation: Conversation | null = await conversations.findOne({
        sessionId,
        sessionType,
      });
      const now = new Date();
      if (!conversation) {
        conversation = await conversations.create({
          sessionId,
          sessionType,
          messageCount: 0,
          lastMessageAt: now,
          metadata: {},
        });
      }
      const messages = adapter.getModel('messages');
      const messageSeq = options?.messageSeq;
      const metadata: Record<string, unknown> = {
        isBotReply: true,
        timestamp: now.toISOString(),
      };
      if (typeof options?.subtext === 'string' && options.subtext.length > 0) {
        metadata.subtext = options.subtext;
      }
      if (Array.isArray(options?.replyTags) && options.replyTags.length > 0) {
        metadata.replyTags = options.replyTags;
      }
      if (typeof options?.viaTool === 'string' && options.viaTool.length > 0) {
        metadata.viaTool = options.viaTool;
      }
      await messages.create({
        conversationId: conversation.id,
        userId: botUserId,
        messageType: isGroup ? 'group' : 'private',
        groupId: isGroup ? targetIdNum : undefined,
        content,
        protocol,
        messageSeq,
        metadata,
      });
      const messageCount = await messages.count({ conversationId: conversation.id });
      await conversations.update(conversation.id, {
        messageCount,
        lastMessageAt: now,
      });
    } catch (error) {
      const err = error instanceof Error ? error : error;
      logger.warn('[ConversationHistoryService] Failed to append bot message to session:', err);
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
    // DB adapter (SQLite) may auto-parse JSON fields, so rawContent can arrive as
    // either a JSON string or an already-parsed array. Handle both cases.
    if (rawContent == null) {
      return undefined;
    }
    if (Array.isArray(rawContent)) {
      return rawContent.length > 0 ? (rawContent as MessageSegment[]) : undefined;
    }
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
   *
   * The window size is the contract; the summary is how the dropped span survives it.
   * When the summarizer yields nothing the span cannot survive, so it is dropped outright
   * rather than stood in for by a placeholder entry — a placeholder reads to the model as
   * "context existed here" while carrying none of it.
   *
   * @param entries - Chronological history entries (oldest first)
   * @param maxEntries - Max entries to keep; when exceeded, oldest are summarized into one
   * @param now - Used for summary entry messageId
   */
  async replaceOldestWithSummary(
    entries: ConversationMessageEntry[],
    maxEntries: number,
    now: Date,
  ): Promise<SummaryRollResult> {
    if (entries.length <= maxEntries) {
      return { entries, replacedCount: 0 };
    }
    const numToSummarize = entries.length - (maxEntries - 1);
    const toSummarize = entries.slice(0, numToSummarize);
    const rest = entries.slice(numToSummarize);
    const conversationText = formatEntriesForSummaryInput(toSummarize);

    let summaryText = '';
    try {
      summaryText = (await this.summarizeService.summarize(conversationText)).trim();
    } catch (err) {
      logger.error('[ConversationHistoryService] Summary roll failed:', err);
    }

    if (!summaryText) {
      logger.warn(
        `[ConversationHistoryService] Summary roll produced no text; dropping ${numToSummarize} oldest entries | ` +
          `conversationTextLength=${conversationText.length}`,
      );
      return { entries: entries.slice(-maxEntries), replacedCount: 0 };
    }

    const summaryEntry: ConversationMessageEntry = {
      messageId: `summary:${now.getTime()}`,
      userId: 0,
      content: summaryText,
      // Not a bot turn: the span it replaces is mostly what other people said, and
      // attributing it to the bot both misplaces those contributions and puts a
      // report-voice paragraph in the model's mouth as its own most recent line.
      isBotReply: false,
      isSummary: true,
      createdAt: toSummarize[0].createdAt,
      summarySpan: { from: toSummarize[0].createdAt, to: toSummarize[toSummarize.length - 1].createdAt },
    };
    return { entries: [summaryEntry, ...rest], replacedCount: numToSummarize };
  }

  /**
   * Build conversation history for prompt.
   * Uses thread context when in proactive thread; then in-memory context.context.history; then DB fallback with same format.
   */
  async buildConversationHistory(context: HookContext): Promise<string> {
    const proactiveThreadId = context.metadata.get('proactiveThreadId');
    if (proactiveThreadId) {
      // THREAD_SERVICE is required (DITokens.ts).
      const threadService = getContainer().resolve<ThreadService>(DITokens.THREAD_SERVICE);
      const text = threadService.getContextFormatted(proactiveThreadId);
      if (text) {
        return text;
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

  /**
   * Get all session messages inside [start, end], sorted by createdAt ascending.
   * Filtering happens in the DB query, so the window comes back complete however
   * much newer traffic the session has since seen — a "load last N, then filter"
   * query silently drops the older part of a window on busy sessions.
   */
  async getMessagesInRange(
    sessionId: string,
    sessionType: 'group' | 'user',
    start: Date,
    end: Date,
    options?: { includeBot?: boolean; maxLimit?: number },
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const canonicalSessionId = normalizeSessionId(sessionId, sessionType);
    const maxLimit = options?.maxLimit ?? 2000;
    const includeBot = options?.includeBot === true;

    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId: canonicalSessionId,
        sessionType,
      });
      if (!conversation) {
        return [];
      }

      const rawDb = (adapter as SQLiteAdapter).getRawDb?.();
      if (!rawDb) {
        return this.getMessagesInRangeFallback(conversation.id, start, end, includeBot, maxLimit);
      }

      const conditions: string[] = ['m.conversationId = ?', 'm.createdAt >= ?', 'm.createdAt <= ?'];
      const params: (string | number)[] = [conversation.id, start.toISOString(), end.toISOString()];
      if (!includeBot) {
        conditions.push('(m.metadata IS NULL OR m.metadata NOT LIKE \'%"isBotReply":true%\')');
      }

      // ASC + LIMIT keeps the OLDEST N of a bounded window, which is where reading
      // a time range starts; DESC would hand back its tail instead.
      const sql = `
        SELECT m.* FROM messages m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.createdAt ASC
        LIMIT ?
      `;
      params.push(maxLimit);

      const rows = rawDb.query(sql).all(...params) as Record<string, unknown>[];
      return rows.map((row) => this.mapMessageToEntry(this.deserializeMessageRow(row)));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] getMessagesInRange failed:', err);
      return [];
    }
  }

  /** Client-side range filter for adapters without raw SQL access (MongoDB). */
  private async getMessagesInRangeFallback(
    conversationId: string,
    start: Date,
    end: Date,
    includeBot: boolean,
    maxLimit: number,
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    const messages = adapter.getModel('messages');
    const recent = await messages.find({ conversationId } as Partial<Message>, {
      orderBy: 'createdAt',
      order: 'desc',
      limit: 2000,
    });

    const startTs = start.getTime();
    const endTs = end.getTime();
    const filtered = (recent as Message[]).filter((msg) => {
      const ts = new Date(msg.createdAt).getTime();
      if (ts < startTs || ts > endTs) return false;
      if (!includeBot && msg.metadata?.isBotReply) return false;
      return true;
    });

    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return filtered.slice(0, maxLimit).map((m) => this.mapMessageToEntry(m));
  }

  /**
   * Search one conversation's messages by content keywords, by sender, or by both.
   *
   * Both filters live on one query because they are the same question asked with
   * different constraints, and "what did X say about Y" needs them together —
   * splitting them into two methods made that combination unexpressible, and left
   * callers keyword-searching a nickname, which matches message bodies and returns
   * everyone talking *about* that person.
   */
  async searchMessages(
    sessionId: string,
    sessionType: 'group' | 'user',
    filter: {
      keywords?: string[];
      userId?: string | number;
      since?: Date;
      includeBot?: boolean;
      limit?: number;
    },
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    const canonicalSessionId = normalizeSessionId(sessionId, sessionType);
    const maxResults = filter.limit ?? 50;

    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId: canonicalSessionId,
        sessionType,
      });
      if (!conversation) {
        return [];
      }

      const rawDb = (adapter as SQLiteAdapter).getRawDb?.();
      if (!rawDb) {
        return this.searchMessagesFallback(conversation.id, filter);
      }

      const conditions: string[] = ['m.conversationId = ?'];
      const params: (string | number)[] = [conversation.id];

      for (const kw of filter.keywords ?? []) {
        conditions.push('m.content LIKE ?');
        params.push(`%${kw}%`);
      }
      if (filter.userId !== undefined) {
        conditions.push('m.userId = ?');
        params.push(filter.userId);
      }
      if (filter.since) {
        conditions.push('m.createdAt >= ?');
        params.push(filter.since.toISOString());
      }
      if (!filter.includeBot) {
        conditions.push('(m.metadata IS NULL OR m.metadata NOT LIKE \'%"isBotReply":true%\')');
      }

      // DESC + LIMIT takes the NEWEST N matches; ASC would silently take the oldest N.
      const sql = `
        SELECT m.* FROM messages m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.createdAt DESC
        LIMIT ?
      `;
      params.push(maxResults);

      const rows = rawDb.query(sql).all(...params) as Record<string, unknown>[];
      rows.reverse(); // restore chronological (oldest→newest) order for display

      return rows.map((row) => this.mapMessageToEntry(this.deserializeMessageRow(row)));
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] searchMessages failed:', err);
      return [];
    }
  }

  /** Same filters applied client-side, for adapters without raw SQL (e.g. MongoDB). */
  private async searchMessagesFallback(
    conversationId: string,
    filter: { keywords?: string[]; userId?: string | number; since?: Date; includeBot?: boolean; limit?: number },
  ): Promise<ConversationMessageEntry[]> {
    const adapter = this.databaseManager.getAdapter();
    const messages = adapter.getModel('messages');
    const limit = filter.limit ?? 50;

    const recent = await messages.find({ conversationId } as Partial<Message>, {
      orderBy: 'createdAt',
      order: 'desc',
      limit: 2000,
    });

    const lowerKeywords = (filter.keywords ?? []).map((k) => k.toLowerCase());
    const sinceTs = filter.since?.getTime();
    const userId = filter.userId !== undefined ? String(filter.userId) : undefined;

    const filtered = (recent as Message[]).filter((msg) => {
      if (sinceTs && new Date(msg.createdAt).getTime() < sinceTs) return false;
      if (!filter.includeBot && msg.metadata?.isBotReply) return false;
      if (userId !== undefined && String(msg.userId) !== userId) return false;
      const contentLower = (msg.content ?? '').toLowerCase();
      return lowerKeywords.every((kw) => contentLower.includes(kw));
    });

    filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return filtered.slice(-limit).map((m) => this.mapMessageToEntry(m));
  }

  /**
   * Resolve a display name to the user ids that have posted under it in this
   * conversation, newest-first by volume.
   *
   * A nickname is not a column — it lives inside each message's
   * `metadata.sender` JSON — so SQL can only pre-filter with LIKE and the
   * match has to be confirmed in JS against the parsed nickname/card. Both
   * are checked because a group card overrides the nickname in what people
   * actually see and type.
   *
   * Returns every candidate rather than picking one: two members can share a
   * display name, and silently guessing between them would attribute one
   * person's messages to another.
   */
  async findUserIdsByDisplayName(
    sessionId: string,
    sessionType: 'group' | 'user',
    displayName: string,
  ): Promise<Array<{ userId: string; displayName: string; messageCount: number }>> {
    const needle = displayName.trim().toLowerCase();
    if (!needle) {
      return [];
    }

    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return [];
    }

    try {
      const conversations = adapter.getModel('conversations');
      const conversation = await conversations.findOne({
        sessionId: normalizeSessionId(sessionId, sessionType),
        sessionType,
      });
      if (!conversation) {
        return [];
      }

      const rows = await this.loadSenderRows(conversation.id, needle);
      const byUser = new Map<string, { userId: string; displayName: string; messageCount: number }>();
      for (const row of rows) {
        const msg = this.deserializeMessageRow(row);
        const meta = msg.metadata ?? {};
        if (meta.isBotReply === true) {
          continue;
        }
        const sender = meta.sender;
        const names = [sender?.card, sender?.nickname].filter((n): n is string => typeof n === 'string' && n !== '');
        const matched = names.find((n) => n.toLowerCase().includes(needle));
        if (!matched) {
          continue;
        }
        const userId = String(msg.userId);
        const seen = byUser.get(userId);
        if (seen) {
          seen.messageCount += 1;
        } else {
          byUser.set(userId, { userId, displayName: matched, messageCount: 1 });
        }
      }

      return [...byUser.values()].sort((a, b) => b.messageCount - a.messageCount);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[ConversationHistoryService] findUserIdsByDisplayName failed:', err);
      return [];
    }
  }

  /**
   * Candidate rows for a display-name lookup. LIKE over the raw metadata JSON is a
   * pre-filter only — it cannot tell a sender name from any other string in the blob,
   * so the caller re-checks each row against the parsed sender.
   */
  private async loadSenderRows(conversationId: string, needle: string): Promise<Record<string, unknown>[]> {
    const adapter = this.databaseManager.getAdapter();
    const rawDb = (adapter as SQLiteAdapter).getRawDb?.();
    if (rawDb) {
      return rawDb
        .query('SELECT m.userId, m.metadata FROM messages m WHERE m.conversationId = ? AND m.metadata LIKE ?')
        .all(conversationId, `%${needle}%`) as Record<string, unknown>[];
    }
    const messages = adapter.getModel('messages');
    const all = await messages.find({ conversationId });
    return all as unknown as Record<string, unknown>[];
  }

  /** Deserialize a raw SQLite row into a Message-like object (mirrors SQLiteModelAccessor.deserialize). */
  private deserializeMessageRow(row: Record<string, unknown>): Message {
    const result = { ...row } as Record<string, unknown>;
    if (result.createdAt) result.createdAt = new Date(result.createdAt as string);
    if (result.updatedAt) result.updatedAt = new Date(result.updatedAt as string);
    // Parse JSON fields
    for (const field of ['metadata', 'rawContent']) {
      if (result[field] && typeof result[field] === 'string') {
        try {
          result[field] = JSON.parse(result[field] as string);
        } catch {
          // keep as string
        }
      }
    }
    return result as unknown as Message;
  }
}
