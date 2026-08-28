// Conversation History Buffer - in-memory rolling buffer of recent messages (not persistent memory)

import type { ConversationMessageEntry } from './ConversationHistoryService';

/**
 * In-memory buffer of conversation messages for a session.
 */
export class ConversationHistoryBuffer {
  private buffer: ConversationMessageEntry[] = [];
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Add message entry to buffer (rich: userId, nickname, etc., same shape as DB entries).
   */
  addMessage(entry: ConversationMessageEntry): void {
    this.buffer.push(entry);

    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /** Raw data: conversation message entries. */
  getEntries(): ConversationMessageEntry[] {
    return [...this.buffer];
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
