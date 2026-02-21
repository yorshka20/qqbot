// Context Manager - builds and manages conversation contexts

import type { SummarizeService } from '@/conversation/SummarizeService';
import { logger } from '@/utils/logger';
import { ConversationHistoryBuffer } from './history/ConversationHistoryBuffer';
import { ConversationHistorySummary } from './history/ConversationHistorySummary';
import type { ContextBuilderOptions, ConversationContext, GlobalContext, SessionContext } from './types';

export interface BuildContextOptions extends ContextBuilderOptions {
  sessionId: string;
  sessionType: 'user' | 'group';
  userId: number;
  groupId?: number;
  systemPrompt?: string;
}

/**
 * Context Manager
 * Builds and manages conversation contexts
 */
export class ContextManager {
  /** Per-session conversation history (buffer or buffer+summary); not persistent memory. */
  private sessionHistory = new Map<string, ConversationHistoryBuffer | ConversationHistorySummary>();
  private globalContext: GlobalContext | null = null;

  constructor(
    private summaryThreshold = 20,
    private maxBufferSize = 30,
    private useSummary = false,
    /** Required when useSummary is true. */
    private summarizeService?: SummarizeService,
  ) { }

  /**
   * Set global context
   */
  setGlobalContext(context: GlobalContext): void {
    this.globalContext = context;
  }

  /**
   * Get or create conversation history for session (in-memory buffer or summary wrapper).
   */
  private getSessionHistory(sessionId: string): ConversationHistoryBuffer | ConversationHistorySummary {
    if (!this.sessionHistory.has(sessionId)) {
      const buffer = new ConversationHistoryBuffer(this.maxBufferSize);
      let history: ConversationHistoryBuffer | ConversationHistorySummary;

      if (this.useSummary && this.summarizeService) {
        history = new ConversationHistorySummary(buffer, this.summaryThreshold, this.summarizeService);
      } else {
        history = buffer;
      }

      this.sessionHistory.set(sessionId, history);
    }
    return this.sessionHistory.get(sessionId)!;
  }

  /**
   * Build conversation context
   */
  buildContext(userMessage: string, options: BuildContextOptions): ConversationContext {
    const sessionHistory = this.getSessionHistory(options.sessionId);

    // Get conversation history
    const history = sessionHistory instanceof ConversationHistorySummary ? sessionHistory.getHistory() : sessionHistory.getFormattedHistory();

    // Build context
    const context: ConversationContext = {
      userMessage,
      history: history.map((msg) => ({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(),
      })),
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

    logger.debug(`[ContextManager] Built context for session: ${options.sessionId}`);

    return context;
  }

  /**
   * Add message to conversation history
   */
  async addMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    const sessionHistory = this.getSessionHistory(sessionId);

    if (sessionHistory instanceof ConversationHistorySummary) {
      await sessionHistory.addMessage(role, content);
    } else {
      sessionHistory.addMessage(role, content);
    }
  }

  /**
   * Clear conversation history for session
   */
  clearSession(sessionId: string): void {
    const sessionHistory = this.sessionHistory.get(sessionId);
    if (sessionHistory) {
      sessionHistory.clear();
    }
  }

  /**
   * Get session context
   */
  getSessionContext(sessionId: string, sessionType: 'user' | 'group'): SessionContext {
    const sessionHistory = this.getSessionHistory(sessionId);
    const history = sessionHistory instanceof ConversationHistorySummary ? sessionHistory.getHistory() : sessionHistory.getFormattedHistory();

    return {
      sessionId,
      sessionType,
      context: {
        messageCount: history.length,
      },
      metadata: new Map(),
    };
  }

  /**
   * Get conversation history for a session
   * Returns formatted history messages for use in AI context
   */
  getHistory(sessionId: string, maxMessages?: number): Array<{ role: 'user' | 'assistant'; content: string }> {
    const sessionHistory = this.getSessionHistory(sessionId);
    const history = sessionHistory instanceof ConversationHistorySummary ? sessionHistory.getHistory() : sessionHistory.getFormattedHistory();

    if (maxMessages && maxMessages > 0) {
      return history.slice(-maxMessages);
    }

    return history;
  }
}
