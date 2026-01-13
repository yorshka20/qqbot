// Conversation Summary Memory - compresses long conversations using summaries

import { PromptManager } from '@/ai/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';
import type { ConversationBufferMemory } from './ConversationBufferMemory';

/**
 * Conversation Summary Memory
 * Compresses long conversations by summarizing old messages
 */
export class ConversationSummaryMemory {
  private summary: string = '';

  constructor(
    private buffer: ConversationBufferMemory,
    private summaryThreshold: number,
    private llmService: LLMService,
    private promptManager: PromptManager,
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
   * Summarize old messages
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

      // Render prompt using PromptManager
      const prompt = this.promptManager.render('llm.summarize', {
        conversationText,
      });

      logger.debug('[ConversationSummaryMemory] Generating summary...');

      const response = await this.llmService.generate(prompt, {
        temperature: 0.5,
        maxTokens: 200,
      });

      // Combine with existing summary
      if (this.summary) {
        this.summary = `${this.summary} ${response.text}`;
      } else {
        this.summary = response.text;
      }

      // Keep only recent messages (last 5) in buffer, remove summarized messages
      // Get recent messages before clearing buffer
      const recentMessages = this.buffer.getHistory().slice(-5);
      this.buffer.clear();
      // Re-add only the recent messages to buffer
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
}
