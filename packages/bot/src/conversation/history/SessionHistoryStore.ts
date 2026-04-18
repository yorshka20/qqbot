// Session History Store - per-session in-memory window, owned by conversation/history

import type { SummarizeService } from '@/ai/services/SummarizeService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { ConversationHistoryBuffer } from './ConversationHistoryBuffer';
import type { ConversationMessageEntry } from './ConversationHistoryService';
import { ConversationHistorySummary } from './ConversationHistorySummary';
import type { ISessionHistory } from './SessionHistory';

/**
 * Per-session in-memory conversation history. Holds one ISessionHistory per session (Buffer or Summary implementation).
 * ContextManager delegates to this; only the interface ISessionHistory is used, no union type.
 */
export class SessionHistoryStore {
  private store = new Map<string, ISessionHistory>();

  constructor(
    private maxBufferSize: number,
    private summaryThreshold: number,
    private useSummary: boolean,
  ) {}

  /**
   * Get or create session history for the given session. Returns interface only.
   */
  getSessionHistory(sessionId: string): ISessionHistory {
    if (!this.store.has(sessionId)) {
      const buffer = new ConversationHistoryBuffer(this.maxBufferSize);
      let history: ISessionHistory;
      if (this.useSummary) {
        const summarizeService = getContainer().resolve<SummarizeService>(DITokens.SUMMARIZE_SERVICE);
        if (!summarizeService) {
          throw new Error('[SessionHistoryStore] SummarizeService not found');
        }
        history = new ConversationHistorySummary(buffer, this.summaryThreshold, summarizeService);
      } else {
        history = buffer;
      }
      this.store.set(sessionId, history);
    }
    return this.store.get(sessionId) as ISessionHistory;
  }

  /** Raw data: entries for the session. */
  getEntries(sessionId: string): ConversationMessageEntry[] {
    return this.getSessionHistory(sessionId).getEntries();
  }

  /** Formatted data: CHS-format string (same format in Buffer and Summary). */
  getFormattedHistory(sessionId: string): string {
    return this.getSessionHistory(sessionId).getFormattedHistory();
  }

  /**
   * Append an entry to the session's history. Buffer and Summary both expose addMessage(entry): Promise<void>.
   */
  async append(sessionId: string, entry: ConversationMessageEntry): Promise<void> {
    await this.getSessionHistory(sessionId).addMessage(entry);
  }

  clearSession(sessionId: string): void {
    this.store.get(sessionId)?.clear();
  }
}
