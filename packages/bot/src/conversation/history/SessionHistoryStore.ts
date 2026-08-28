// Session History Store - per-session in-memory window, owned by conversation/history

import { ConversationHistoryBuffer } from './ConversationHistoryBuffer';
import type { ConversationMessageEntry } from './ConversationHistoryService';

/**
 * Per-session in-memory conversation history: one rolling buffer of recent entries per session.
 * ContextManager delegates to this.
 *
 * Long-range compaction is not this store's job. Its readers ask for a recent window, and the
 * reply path builds its own summarized window in EpisodeCacheManager.
 */
export class SessionHistoryStore {
  private store = new Map<string, ConversationHistoryBuffer>();

  constructor(private maxBufferSize: number) {}

  /**
   * Get or create session history for the given session.
   */
  getSessionHistory(sessionId: string): ConversationHistoryBuffer {
    let history = this.store.get(sessionId);
    if (!history) {
      history = new ConversationHistoryBuffer(this.maxBufferSize);
      this.store.set(sessionId, history);
    }
    return history;
  }

  /** Raw data: entries for the session. */
  getEntries(sessionId: string): ConversationMessageEntry[] {
    return this.getSessionHistory(sessionId).getEntries();
  }

  /** Append an entry to the session's history. */
  append(sessionId: string, entry: ConversationMessageEntry): void {
    this.getSessionHistory(sessionId).addMessage(entry);
  }

  clearSession(sessionId: string): void {
    this.store.get(sessionId)?.clear();
  }
}
