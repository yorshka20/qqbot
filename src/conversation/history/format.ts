// Shared formatter for conversation history entries (same format as ConversationHistoryService.formatAsText)

import type { ConversationMessageEntry } from './ConversationHistoryService';

function formatSimpleTime(d: Date): string {
  const M = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${M}/${day} ${h}:${m}`;
}

/**
 * Format a single message entry for storage (e.g. RAG payload). No [id:i] prefix so stored content is clean.
 * Use when persisting one message per document (e.g. Qdrant embedding).
 */
export function formatSingleEntryToText(entry: ConversationMessageEntry): string {
  const who = entry.isBotReply
    ? 'Assistant'
    : `User<${entry.userId}${entry.nickname != null && entry.nickname !== '' ? `:${entry.nickname}` : ''}>`;
  const t = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt);
  const timeStr = formatSimpleTime(t);
  const atBotMark = !entry.isBotReply && entry.wasAtBot ? ' [用户@机器人，已针对性回复]' : '';
  return `${timeStr} ${who}: ${entry.content}${atBotMark}`;
}

/**
 * Format message entries as a single text (User<userId:nickname> / Assistant, [id], time).
 * Shared by ConversationHistoryService and ConversationHistorySummary so output format is consistent.
 * For single-message storage (e.g. RAG payload) use formatSingleEntryToText so content has no [id:0].
 */
export function formatConversationEntriesToText(entries: ConversationMessageEntry[]): string {
  return entries
    .map((e, i) => {
      const line = formatSingleEntryToText(e);
      return `[id:${i}] ${line}`;
    })
    .join('\n');
}
