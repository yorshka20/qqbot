// Conversation History Summary - compresses long session history using summaries (not persistent memory)

import type { SummarizeService } from '@/conversation/SummarizeService';
import { logger } from '@/utils/logger';
import type { ConversationHistoryBuffer } from './ConversationHistoryBuffer';

/**
 * Wraps ConversationHistoryBuffer and compresses old messages into a summary when buffer exceeds threshold.
 * Used by ContextManager for long sessions; not the same as persistent Memory in @/memory.
 */
export class ConversationHistorySummary {
  private summary: string = '';

  constructor(
    private buffer: ConversationHistoryBuffer,
    private summaryThreshold: number,
    private summarizeService: SummarizeService,
  ) {}

  /**
   * Add message and potentially summarize if buffer is too large
   */
  async addMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    this.buffer.addMessage(role, content);

    // Summarize if buffer exceeds threshold
    if (this.buffer.size() > this.summaryThreshold) {
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
   * Summarize old messages (uses unified SummarizeService with default provider).
   */
  private async summarize(): Promise<void> {
    try {
      const oldMessages = this.buffer.getHistory().slice(0, -5); // Keep last 5 messages
      if (oldMessages.length === 0) {
        return;
      }

      const conversationText = oldMessages
        .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n');

      logger.debug('[ConversationHistorySummary] Generating summary...');

      const summaryText = await this.summarizeService.summarize(conversationText);

      // Combine with existing summary
      if (this.summary) {
        this.summary = `${this.summary} ${summaryText}`;
      } else {
        this.summary = summaryText;
      }

      // Keep only recent messages (last 5) in buffer, remove summarized messages
      const recentMessages = this.buffer.getHistory().slice(-5);
      this.buffer.clear();
      for (const msg of recentMessages) {
        this.buffer.addMessage(msg.role, msg.content);
      }

      logger.debug('[ConversationHistorySummary] Summary generated');
    } catch (error) {
      logger.error('[ConversationHistorySummary] Failed to generate summary:', error);
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
}
