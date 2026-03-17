// Format RAG-retrieved conversation hits for prompt injection (time, participants with id+nickname, clear separators)

import type { RAGSearchResult } from '@/services/retrieval/rag/types';
import { formatDateTimeShort } from '@/utils/dateTime';

/** Single message in conversation window RAG payload (userId, optional nickname, text, timestamp). */
export interface RawMessageItem {
  userId: number;
  nickname?: string;
  text: string;
  timestamp: string;
}

/**
 * Payload shape of a conversation history RAG point as stored in Qdrant.
 * All fields are required; content is set on upsert from the document content.
 */
export interface ConversationWindowPayload {
  sessionId: string;
  sessionType: string;
  startTime: string;
  endTime: string;
  participants: number[];
  rawMessages: RawMessageItem[];
  groupId?: number;
  content: string;
}

/** Type guard: ensure hit payload is ConversationWindowPayload. */
function isConversationWindowPayload(payload: unknown): payload is ConversationWindowPayload {
  if (payload == null || typeof payload !== 'object') {
    return false;
  }
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === 'string' &&
    typeof p.sessionType === 'string' &&
    typeof p.startTime === 'string' &&
    typeof p.endTime === 'string' &&
    Array.isArray(p.participants) &&
    Array.isArray(p.rawMessages) &&
    typeof p.content === 'string'
  );
}

/** Format a single ISO time for display (e.g. 2026-02-28 15:30) using Asia/Tokyo timezone. */
const formatTimeShort = formatDateTimeShort;

/**
 * Build participant list from rawMessages: "昵称(userId)" so AI can match content speaker labels (e.g. "笑忘:") to identity.
 * Order by first appearance; dedupe by userId.
 */
function formatParticipantsFromRawMessages(rawMessages: RawMessageItem[]): string {
  if (rawMessages.length === 0) {
    return '';
  }
  const seen = new Set<number>();
  const parts: string[] = [];
  for (const msg of rawMessages) {
    const uid = msg.userId;
    if (seen.has(uid)) {
      continue;
    }
    seen.add(uid);
    const name = typeof msg.nickname === 'string' && msg.nickname.trim() !== '' ? msg.nickname.trim() : null;
    parts.push(name ? `${name}(${uid})` : String(uid));
  }
  return parts.length > 0 ? `参与者: ${parts.join(', ')}` : '';
}

/**
 * Format RAG search hits into one string for the "相关历史对话" section.
 * Each entry gets: time range, participants (nickname(userId)), and content. Only hits with valid ConversationWindowPayload are used.
 */
export function formatRAGConversationContext(hits: RAGSearchResult[]): string {
  const parts = hits
    .filter((r) => {
      const p = r.payload ?? {};
      return isConversationWindowPayload(p) && r.content != null && r.content.trim().length > 0;
    })
    .map((r, index) => {
      const payload = r.payload as unknown as ConversationWindowPayload;
      const content = payload.content.trim();
      const timeStr = `${formatTimeShort(payload.startTime)} ～ ${formatTimeShort(payload.endTime)}`;
      const participantStr = formatParticipantsFromRawMessages(payload.rawMessages);

      const header = [`【历史片段 ${index + 1}】`, `时间: ${timeStr}`, participantStr].filter(Boolean).join('\n');
      return `${header}\n\n${content}`;
    });

  return parts.join('\n\n────\n\n');
}
