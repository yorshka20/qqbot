// Conversation History Summary - compresses long session history using summaries (not persistent memory)

import type { SummarizeService } from '@/ai/services/SummarizeService';
import { logger } from '@/utils/logger';
import type { ConversationHistoryBuffer } from './ConversationHistoryBuffer';
import type { ConversationMessageEntry } from './ConversationHistoryService';
import { formatConversationEntriesToText } from './format';
import type { ISessionHistory } from './SessionHistory';

/**
 * Wraps ConversationHistoryBuffer and compresses old messages into a summary when buffer exceeds threshold. Implements ISessionHistory.
 */
export class ConversationHistorySummary implements ISessionHistory {
  private summary: string = '';

  constructor(
    private buffer: ConversationHistoryBuffer,
    private summaryThreshold: number,
    private summarizeService: SummarizeService,
  ) {}

  /**
   * Add message entry and potentially summarize if buffer is too large.
   */
  async addMessage(entry: ConversationMessageEntry): Promise<void> {
    this.buffer.addMessage(entry);

    if (this.buffer.size() > this.summaryThreshold) {
      await this.summarize();
    }
  }

  /** Raw data: recent entries only (summary is not an entry). */
  getEntries(): ConversationMessageEntry[] {
    return this.buffer.getEntries();
  }

  /** Formatted data: CHS-format string; if summary exists, one Assistant line first then recent entries. Same format as Buffer. */
  getFormattedHistory(): string {
    const entries = this.buffer.getEntries();
    const recentText = formatConversationEntriesToText(entries);
    if (!this.summary) {
      return recentText;
    }
    const summaryLine = `[id:0] 0/0 00:00 Assistant: [Previous conversation summary: ${this.summary}]`;
    if (!recentText) {
      return summaryLine;
    }
    // Re-index recent lines so they start at [id:1], [id:2], ...
    const recentLines = recentText.split('\n');
    const reindexed = recentLines.map((line, i) => line.replace(/^\[id:\d+\]/, `[id:${i + 1}]`));
    return [summaryLine, ...reindexed].join('\n');
  }

  /**
   * Summarize old messages using same format as ConversationHistoryService for input to summarizer.
   */
  private async summarize(): Promise<void> {
    try {
      const oldEntries = this.buffer.getEntries().slice(0, -5);
      if (oldEntries.length === 0) {
        return;
      }

      const conversationText = formatConversationEntriesToText(oldEntries);

      logger.debug('[ConversationHistorySummary] Generating summary...');

      const summaryText = await this.summarizeService.summarize(conversationText);

      if (this.summary) {
        this.summary = `${this.summary} ${summaryText}`;
      } else {
        this.summary = summaryText;
      }

      const recentEntries = this.buffer.getEntries().slice(-5);
      this.buffer.clear();
      for (const entry of recentEntries) {
        this.buffer.addMessage(entry);
      }

      logger.debug('[ConversationHistorySummary] Summary generated');
    } catch (error) {
      logger.error('[ConversationHistorySummary] Failed to generate summary:', error);
    }
  }

  clear(): void {
    this.summary = '';
    this.buffer.clear();
  }
}
