// Build one RAG document from a window of conversation entries (for time-windowed RAG storage)

import type { ConversationMessageEntry } from '@/conversation/history';
import { formatContentWithSpeakerForRAG } from '@/conversation/history';
import type { RAGDocument } from '@/services/retrieval/rag/types';

/**
 * Group sorted entries into windows by idle minutes or max messages per window.
 * Entries must be in ascending createdAt order.
 */
export function groupEntriesIntoWindows(
  entries: ConversationMessageEntry[],
  idleMinutes: number,
  maxMessages: number,
): ConversationMessageEntry[][] {
  if (entries.length === 0) {
    return [];
  }
  const idleMs = idleMinutes * 60 * 1000;
  const windows: ConversationMessageEntry[][] = [];
  let current: ConversationMessageEntry[] = [];
  let lastTime = 0;

  for (const entry of entries) {
    const t = entry.createdAt instanceof Date ? entry.createdAt.getTime() : new Date(entry.createdAt).getTime();
    const gapExceeded = current.length > 0 && t - lastTime > idleMs;
    const countExceeded = current.length >= maxMessages;
    if (current.length > 0 && (gapExceeded || countExceeded)) {
      windows.push(current);
      current = [];
    }
    current.push(entry);
    lastTime = t;
  }
  if (current.length > 0) {
    windows.push(current);
  }
  return windows;
}

/** Max length of window content (chars). Hard cut so context window does not exceed limit. */
const CONVERSATION_WINDOW_CONTENT_MAX_CHARS = 1000;

export interface ConversationWindowPayload {
  sessionId: string;
  sessionType: string;
  groupId?: number | string;
  startTime: string;
  endTime: string;
  participants: (number | string)[];
  /** Each message includes userId and nickname so payload can be matched to content (content uses nickname as speaker label). */
  rawMessages: Array<{ userId: number | string; nickname?: string; text: string; timestamp: string }>;
}

/**
 * Build one RAG document from a list of conversation entries (one time window).
 * Content is speaker-prefixed lines joined by newline.
 * Payload includes startTime, endTime, participants, rawMessages.
 */
export function buildConversationWindowDocument(
  entries: ConversationMessageEntry[],
  sessionId: string,
  sessionType: string,
  groupId?: number,
): RAGDocument {
  if (entries.length === 0) {
    const t0 = new Date(0).toISOString();
    const emptyPayload: Record<string, unknown> = {
      sessionId,
      sessionType,
      startTime: t0,
      endTime: t0,
      participants: [],
      rawMessages: [],
    };
    if (groupId != null) {
      emptyPayload.groupId = groupId;
    }
    return { id: `${sessionId}:0`, content: '', payload: emptyPayload };
  }

  const first = entries[0];
  const last = entries[entries.length - 1];
  const startTime = first.createdAt instanceof Date ? first.createdAt : new Date(first.createdAt);
  const endTime = last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt);
  const windowStartMs = startTime.getTime();

  let content = entries.map((e) => formatContentWithSpeakerForRAG(e)).join('\n');
  if (content.length > CONVERSATION_WINDOW_CONTENT_MAX_CHARS) {
    content = content.slice(0, CONVERSATION_WINDOW_CONTENT_MAX_CHARS);
  }
  const participants = [...new Set(entries.map((e) => e.userId))];
  const rawMessages = entries.map((e) => ({
    userId: e.userId,
    nickname: e.nickname,
    text: e.content,
    timestamp: (e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt)).toISOString(),
  }));

  const payload: Record<string, unknown> = {
    sessionId,
    sessionType,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    participants,
    rawMessages,
  };
  if (groupId != null) {
    payload.groupId = groupId;
  }

  return {
    id: `${sessionId}:${windowStartMs}`,
    content,
    payload,
  };
}
