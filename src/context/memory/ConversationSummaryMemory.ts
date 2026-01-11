// Conversation Summary Memory - compresses long conversations using summaries

import type { ConversationBufferMemory } from './ConversationBufferMemory';
import type { AIManager } from '@/ai/AIManager';
import { logger } from '@/utils/logger';

/**
 * Conversation Summary Memory
 * Compresses long conversations by summarizing old messages
 */
export class ConversationSummaryMemory {
  private summary: string = '';
  private buffer: ConversationBufferMemory;
  private summaryThreshold: number;
  private aiManager: AIManager | null = null;

  constructor(
    buffer: ConversationBufferMemory,
    summaryThreshold = 20,
    aiManager?: AIManager,
  ) {
    this.buffer = buffer;
    this.summaryThreshold = summaryThreshold;
    this.aiManager = aiManager || null;
  }

  /**
   * Add message and potentially summarize if buffer is too large
   */
  async addMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    this.buffer.addMessage(role, content);

    // Summarize if buffer exceeds threshold
    if (this.buffer.size() > this.summaryThreshold && this.aiManager) {
      await this.summarize();
    }
  }

  /**
   * Get conversation history with summary
   */
  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Add summary if exists
    if (this.summary) {
      history.push({
        role: 'assistant',
        content: `[Previous conversation summary: ${this.summary}]`,
      });
    }

    // Add recent messages
    history.push(...this.buffer.getFormattedHistory());

    return history;
  }

  /**
   * Summarize old messages
   */
  private async summarize(): Promise<void> {
    if (!this.aiManager) {
      logger.warn('[ConversationSummaryMemory] AI manager not available, skipping summary');
      return;
    }

    try {
      const oldMessages = this.buffer.getHistory().slice(0, -5); // Keep last 5 messages
      if (oldMessages.length === 0) {
        return;
      }

      const conversationText = oldMessages
        .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n');

      const prompt = `Summarize the following conversation in 2-3 sentences, focusing on key topics and decisions:

${conversationText}

Summary:`;

      logger.debug('[ConversationSummaryMemory] Generating summary...');

      const response = await this.aiManager.generate(prompt, {
        temperature: 0.5,
        maxTokens: 200,
      });

      // Combine with existing summary
      if (this.summary) {
        this.summary = `${this.summary} ${response.text}`;
      } else {
        this.summary = response.text;
      }

      // Remove summarized messages from buffer
      for (let i = 0; i < oldMessages.length; i++) {
        // Buffer will auto-trim, but we need to manually remove
        // Since we can't directly remove, we'll recreate buffer with remaining messages
      }

      // Keep only recent messages
      const recentMessages = this.buffer.getHistory().slice(-5);
      this.buffer.clear();
      for (const msg of recentMessages) {
        this.buffer.addMessage(msg.role, msg.content);
      }

      logger.debug('[ConversationSummaryMemory] Summary generated');
    } catch (error) {
      logger.error('[ConversationSummaryMemory] Failed to generate summary:', error);
      // Continue without summary
    }
  }

  /**
   * Clear summary and buffer
   */
  clear(): void {
    this.summary = '';
    this.buffer.clear();
  }

  /**
   * Set AI manager for summarization
   */
  setAIManager(aiManager: AIManager): void {
    this.aiManager = aiManager;
  }
}
