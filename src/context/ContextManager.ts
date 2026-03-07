// Context Manager - builds and manages conversation contexts

import type { ConversationHistoryRole } from '@/ai/types';
import type { ConversationMessageEntry, SessionHistoryStore } from '@/conversation/history';
import type { ContextBuilderOptions, ConversationContext, GlobalContext, SessionContext } from './types';

export interface AddMessageOptions {
  userId?: number;
  nickname?: string;
  messageId?: string;
  wasAtBot?: boolean;
}

export interface BuildContextOptions extends ContextBuilderOptions {
  sessionId: string;
  sessionType: 'user' | 'group';
  userId: number;
  groupId?: number;
  systemPrompt?: string;
}

/**
 * Context Manager
 * Builds and manages conversation contexts; session history is owned by SessionHistoryStore (conversation/history).
 */
export class ContextManager {
  private globalContext: GlobalContext | null = null;

  constructor(private sessionHistoryStore: SessionHistoryStore) {}

  setGlobalContext(context: GlobalContext): void {
    this.globalContext = context;
  }

  /**
   * Build conversation context (history from raw entries mapped to role+content).
   */
  buildContext(userMessage: string, options: BuildContextOptions): ConversationContext {
    const entries = this.sessionHistoryStore.getEntries(options.sessionId);
    const history = entries.map((e) => ({
      role: (e.isBotReply ? 'assistant' : 'user') as ConversationHistoryRole,
      content: e.content,
      timestamp: e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt),
    }));

    const context: ConversationContext = {
      userMessage,
      history,
      userId: options.userId,
      groupId: options.groupId,
      messageType: options.sessionType === 'group' ? 'group' : 'private',
      systemPrompt: options.systemPrompt || this.globalContext?.systemPrompt,
      metadata: new Map(),
    };

    // Add metadata
    context.metadata.set('sessionId', options.sessionId);
    context.metadata.set('sessionType', options.sessionType);
    context.metadata.set('userId', options.userId);
    if (options.groupId) {
      context.metadata.set('groupId', options.groupId);
    }

    return context;
  }

  /**
   * Add message to conversation history (rich entry: userId, nickname, etc., for consistent format with DB path).
   */
  async addMessage(
    sessionId: string,
    role: ConversationHistoryRole,
    content: string,
    options?: AddMessageOptions,
  ): Promise<void> {
    const now = new Date();
    const entry: ConversationMessageEntry = {
      messageId: options?.messageId ?? `mem:${now.getTime()}`,
      userId: role === 'user' ? (options?.userId ?? 0) : 0,
      nickname: options?.nickname,
      content,
      isBotReply: role === 'assistant',
      createdAt: now,
      wasAtBot: options?.wasAtBot,
    };

    await this.sessionHistoryStore.append(sessionId, entry);
  }

  /**
   * Clear conversation history for session
   */
  clearSession(sessionId: string): void {
    this.sessionHistoryStore.clearSession(sessionId);
  }

  /**
   * Get session context
   */
  getSessionContext(sessionId: string, sessionType: 'user' | 'group'): SessionContext {
    const entries = this.sessionHistoryStore.getEntries(sessionId);
    return {
      sessionId,
      sessionType,
      context: { messageCount: entries.length },
      metadata: new Map(),
    };
  }

  /**
   * Get conversation history for a session (role + content for AI context), from raw entries.
   */
  getHistory(sessionId: string, maxMessages?: number): Array<{ role: ConversationHistoryRole; content: string }> {
    const entries = this.sessionHistoryStore.getEntries(sessionId);
    const history = entries.map((e) => ({
      role: (e.isBotReply ? 'assistant' : 'user') as ConversationHistoryRole,
      content: e.content,
    }));
    if (maxMessages != null && maxMessages > 0) {
      return history.slice(-maxMessages);
    }
    return history;
  }
}
