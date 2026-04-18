// Session history interface - contract for per-session in-memory window (Buffer and Summary implement this)

import type { ConversationHistoryRole } from '@/ai/types';
import type { ConversationMessageEntry } from './ConversationHistoryService';

/** Formatted message for context (role + content only). */
export type FormattedHistoryItem = { role: ConversationHistoryRole; content: string };

/**
 * Contract for a session's in-memory history. Two functions: raw entries and formatted string (CHS format only).
 */
export interface ISessionHistory {
  /** Raw data: conversation message entries (same shape as DB). */
  getEntries(): ConversationMessageEntry[];
  /** Formatted data: single string in CHS format (User<userId:nickname> / Assistant, [id], time). Same format in Buffer and Summary. */
  getFormattedHistory(): string;
  addMessage(entry: ConversationMessageEntry): Promise<void>;
  clear(): void;
}
