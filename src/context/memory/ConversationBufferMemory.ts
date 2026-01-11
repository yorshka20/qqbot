// Conversation Buffer Memory - stores conversation history in memory

import type { ConversationContext } from '../types';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

/**
 * Conversation Buffer Memory
 * Stores conversation history in a buffer with configurable size limit
 */
export class ConversationBufferMemory {
  private buffer: ConversationMessage[] = [];
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Add message to buffer
   */
  addMessage(role: 'user' | 'assistant', content: string): void {
    this.buffer.push({
      role,
      content,
      timestamp: new Date(),
    });

    // Trim buffer if exceeds max size
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift(); // Remove oldest message
    }
  }

  /**
   * Get conversation history
   */
  getHistory(): ConversationMessage[] {
    return [...this.buffer];
  }

  /**
   * Get formatted history for AI context
   */
  getFormattedHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.buffer.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get buffer size
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Set max buffer size
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    // Trim buffer if needed
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }
}
