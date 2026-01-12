// Context Manager - builds and manages conversation contexts

import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';
import { ConversationBufferMemory } from './memory/ConversationBufferMemory';
import { ConversationSummaryMemory } from './memory/ConversationSummaryMemory';
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
  private memories = new Map<string, ConversationBufferMemory | ConversationSummaryMemory>();
  private globalContext: GlobalContext | null = null;
  private maxBufferSize: number;

  constructor(
    private llmService?: LLMService,
    private useSummary = false,
    private summaryThreshold = 20,
    maxBufferSize = 30,
  ) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Set global context
   */
  setGlobalContext(context: GlobalContext): void {
    this.globalContext = context;
  }

  /**
   * Get or create memory for session
   */
  private getMemory(sessionId: string): ConversationBufferMemory | ConversationSummaryMemory {
    if (!this.memories.has(sessionId)) {
      // Use configured maxBufferSize
      const buffer = new ConversationBufferMemory(this.maxBufferSize);
      const memory =
        this.useSummary && this.llmService
          ? new ConversationSummaryMemory(buffer, this.summaryThreshold, this.llmService)
          : buffer;
      this.memories.set(sessionId, memory);
    }
    return this.memories.get(sessionId)!;
  }

  /**
   * Build conversation context
   */
  buildContext(userMessage: string, options: BuildContextOptions): ConversationContext {
    const memory = this.getMemory(options.sessionId);

    // Get conversation history
    const history = memory instanceof ConversationSummaryMemory ? memory.getHistory() : memory.getFormattedHistory();

    // Build context
    const context: ConversationContext = {
      userMessage,
      history: history.map((msg) => ({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(),
      })),
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
    const memory = this.getMemory(sessionId);

    if (memory instanceof ConversationSummaryMemory) {
      await memory.addMessage(role, content);
    } else {
      memory.addMessage(role, content);
    }
  }

  /**
   * Clear conversation history for session
   */
  clearSession(sessionId: string): void {
    const memory = this.memories.get(sessionId);
    if (memory) {
      memory.clear();
    }
  }

  /**
   * Get session context
   */
  getSessionContext(sessionId: string, sessionType: 'user' | 'group'): SessionContext {
    const memory = this.getMemory(sessionId);
    const history = memory instanceof ConversationSummaryMemory ? memory.getHistory() : memory.getFormattedHistory();

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
    const memory = this.getMemory(sessionId);
    const history = memory instanceof ConversationSummaryMemory ? memory.getHistory() : memory.getFormattedHistory();

    if (maxMessages && maxMessages > 0) {
      return history.slice(-maxMessages);
    }

    return history;
  }
}
