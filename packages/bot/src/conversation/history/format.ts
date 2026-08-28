// Shared formatter for conversation history entries (same format as ConversationHistoryService.formatAsText)

import { buildSpeakerTag } from '@/ai/prompt/speakerTag';
import { formatTimeCompact, formatTimeSpanCompact } from '@/utils/dateTime';
import type { ConversationMessageEntry } from './ConversationHistoryService';

/** Format time in compact form (M/DD HH:mm) using Asia/Tokyo timezone. */
const formatSimpleTime = (d: Date): string => formatTimeCompact(d);

/**
 * Format a single message entry for RAG storage: speaker label + content only (no date, no User<id> wrapper).
 * Use for embedding so merged windows can still distinguish who said what.
 * User: "nickname: content" or "userId: content"; bot: "Assistant: content".
 */
export function formatContentWithSpeakerForRAG(entry: ConversationMessageEntry): string {
  if (entry.isBotReply) {
    return `Assistant: ${entry.content}`;
  }
  const speaker = entry.nickname != null && entry.nickname !== '' ? entry.nickname : String(entry.userId);
  return `${speaker}: ${entry.content}`;
}

/**
 * Format a single message entry for storage (e.g. RAG payload). No [id:i] prefix so stored content is clean.
 * Use when persisting one message per document (e.g. Qdrant embedding).
 */
function summaryLabel(entry: ConversationMessageEntry): string {
  return `[前序对话摘要 ${formatTimeSpanCompact(entry.summarySpan?.from ?? entry.createdAt, entry.summarySpan?.to)}]`;
}

export function formatSingleEntryToText(entry: ConversationMessageEntry): string {
  if (entry.isSummary) {
    return `${summaryLabel(entry)} ${entry.content}`;
  }
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
 * Shared by ConversationHistoryService and the avatar memory extractor so output format is consistent.
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

/**
 * Format entries as the summarizer's input.
 *
 * Speakers are tagged with the prompt surface's canonical `[speaker:<nick>:<uid>]`
 * rather than the `User<uid:nick>` the other flat-text renderings use. The summary
 * this produces is injected beside live history carrying that exact tag, and the
 * model has to recognise "whoever said this earlier" as the person speaking now —
 * asking it to transliterate between two speaker grammars is how the uid and nick
 * end up swapped. The two forms are not merged because `prompts/memory/extract.txt`
 * documents `User<…>` as its own input contract.
 */
export function formatEntriesForSummaryInput(entries: ConversationMessageEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.isSummary) {
        return `${summaryLabel(entry)} ${entry.content}`;
      }
      const who = entry.isBotReply ? 'Assistant' : buildSpeakerTag(String(entry.userId), entry.nickname);
      return `${formatTimeCompact(entry.createdAt)} ${who}: ${entry.content}`;
    })
    .join('\n');
}
