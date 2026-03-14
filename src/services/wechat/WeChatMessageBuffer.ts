// WeChat message buffer: accumulates messages per conversation, flushes on idle or max count

import { logger } from '@/utils/logger';
import type { ParsedWeChatMessage } from './types';

export type BufferFlushCallback = (conversationId: string, messages: ParsedWeChatMessage[]) => Promise<void>;

interface BufferEntry {
  conversationId: string;
  messages: ParsedWeChatMessage[];
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class WeChatMessageBuffer {
  private buffers = new Map<string, BufferEntry>();
  private readonly idleMs: number;
  private readonly maxMessages: number;
  private readonly onFlush: BufferFlushCallback;

  constructor(opts: {
    idleMinutes: number;
    maxMessages: number;
    onFlush: BufferFlushCallback;
  }) {
    this.idleMs = opts.idleMinutes * 60 * 1_000;
    this.maxMessages = opts.maxMessages;
    this.onFlush = opts.onFlush;
  }

  push(msg: ParsedWeChatMessage): void {
    const { conversationId } = msg;
    let entry = this.buffers.get(conversationId);

    if (!entry) {
      entry = { conversationId, messages: [], idleTimer: null };
      this.buffers.set(conversationId, entry);
    }

    entry.messages.push(msg);

    // Reset idle timer
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.flush(conversationId).catch((err) =>
        logger.error(`[WeChatMessageBuffer] idle flush error for ${conversationId}:`, err),
      );
    }, this.idleMs);

    // Flush immediately if max reached
    if (entry.messages.length >= this.maxMessages) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
      this.flush(conversationId).catch((err) =>
        logger.error(`[WeChatMessageBuffer] max flush error for ${conversationId}:`, err),
      );
    }
  }

  /** Flush all buffered conversations (e.g. on shutdown) */
  async flushAll(): Promise<void> {
    const ids = [...this.buffers.keys()];
    await Promise.allSettled(ids.map((id) => this.flush(id)));
  }

  private async flush(conversationId: string): Promise<void> {
    const entry = this.buffers.get(conversationId);
    if (!entry || entry.messages.length === 0) return;

    const messages = entry.messages.splice(0);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.buffers.delete(conversationId);

    try {
      await this.onFlush(conversationId, messages);
    } catch (err) {
      logger.error(`[WeChatMessageBuffer] onFlush error for ${conversationId}:`, err);
    }
  }

  destroy(): void {
    for (const entry of this.buffers.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    this.buffers.clear();
  }
}
