// Conversation History Buffer - in-memory rolling buffer of recent messages (not persistent memory)

import type { ConversationMessageEntry } from './ConversationHistoryService';
import { formatConversationEntriesToText } from './format';
import type { ISessionHistory } from './SessionHistory';

/**
 * In-memory buffer of conversation messages for a session. Implements ISessionHistory (raw + CHS-formatted).
 */
export class ConversationHistoryBuffer implements ISessionHistory {
  private buffer: ConversationMessageEntry[] = [];
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Add message entry to buffer (rich: userId, nickname, etc., same shape as DB entries).
   * Returns Promise so Buffer and Summary share the same async interface for Store.append().
   */
  async addMessage(entry: ConversationMessageEntry): Promise<void> {
    this.buffer.push(entry);

    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /** Raw data: conversation message entries. */
  getEntries(): ConversationMessageEntry[] {
    return [...this.buffer];
  }

  /** Formatted data: CHS-format string (User<userId:nickname> / Assistant, [id], time). */
  getFormattedHistory(): string {
    return formatConversationEntriesToText(this.getEntries());
  }

  clear(): void {
    this.buffer = [];
  }

  size(): number {
    return this.buffer.length;
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }
}
