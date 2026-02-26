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
 * Format message entries as a single text (User<userId:nickname> / Assistant, [id], time).
 * Shared by ConversationHistoryService and ConversationHistorySummary so output format is consistent.
 */
export function formatConversationEntriesToText(entries: ConversationMessageEntry[]): string {
  return entries
    .map((e, i) => {
      const who = e.isBotReply
        ? 'Assistant'
        : `User<${e.userId}${e.nickname != null && e.nickname !== '' ? `:${e.nickname}` : ''}>`;
      const t = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
      const timeStr = formatSimpleTime(t);
      const atBotMark = !e.isBotReply && e.wasAtBot ? ' [用户@机器人，已针对性回复]' : '';
      return `[id:${i}] ${timeStr} ${who}: ${e.content}${atBotMark}`;
    })
    .join('\n');
}
