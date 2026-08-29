// Turning "the name the model has" into "the QQ id every tool wants".
//
// Group members reach the model as display names — off a screenshot, an @ in someone
// else's message, a leaderboard — while the numeric id only appears for people who
// spoke in the visible window. Tools that accept the id alone are unusable in exactly
// the cases the model most needs them, so each of them takes a nickname too and routes
// it through here.

import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { ConversationScope } from './conversationScope';

export interface SenderCandidate {
  userId: string;
  displayName: string;
  messageCount: number;
}

export type SenderResolution =
  /** Neither identifier was supplied — the caller decides whether that is an error. */
  | { kind: 'none' }
  | { kind: 'resolved'; userId: string; label: string }
  | { kind: 'not_found'; nickname: string; message: string }
  | { kind: 'ambiguous'; nickname: string; candidates: SenderCandidate[]; message: string };

/**
 * Resolve whichever identifier the call carried into a single QQ id.
 *
 * An explicit id always wins — it needs no lookup and cannot be ambiguous. A nickname
 * is matched against this conversation's own speakers, and several matches come back
 * as a candidate list rather than a guess: choosing the loudest of two people sharing
 * a card would quietly attribute one person's words to another.
 */
export async function resolveSender(
  history: ConversationHistoryService,
  scope: ConversationScope,
  params: { userId?: unknown; nickname?: unknown },
): Promise<SenderResolution> {
  const userId = params.userId;
  if (typeof userId === 'string' && userId.trim()) {
    return { kind: 'resolved', userId: userId.trim(), label: userId.trim() };
  }
  if (typeof userId === 'number' && Number.isFinite(userId)) {
    return { kind: 'resolved', userId: String(userId), label: String(userId) };
  }

  const nickname = params.nickname;
  if (typeof nickname !== 'string' || !nickname.trim()) {
    return { kind: 'none' };
  }

  const needle = nickname.trim();
  const candidates = await history.findUserIdsByDisplayName(scope.sessionId, scope.sessionType, needle);

  if (candidates.length === 0) {
    return {
      kind: 'not_found',
      nickname: needle,
      message: `本会话历史里没有昵称匹配「${needle}」的发言人`,
    };
  }

  if (candidates.length > 1) {
    const list = candidates.map((c) => `- ${c.displayName} (${c.userId})，${c.messageCount} 条发言`).join('\n');
    return {
      kind: 'ambiguous',
      nickname: needle,
      candidates,
      message: `昵称「${needle}」匹配到多个人，请用 userId 指定其中一个：\n${list}`,
    };
  }

  return {
    kind: 'resolved',
    userId: candidates[0].userId,
    label: `${candidates[0].displayName}(${candidates[0].userId})`,
  };
}

/** Shared parameter docs, so every tool describes the same pair the same way. */
export const SENDER_PARAM_DESCRIPTIONS = {
  userId: '目标用户的 QQ 号（仅数字），例如发言人前缀 [speaker:<昵称>:<QQ号>] 中的 QQ 号部分。',
  nickname:
    '目标用户的昵称或群名片，用于手上只有名字、没有 QQ 号时。按本会话历史发言人解析，支持部分匹配；命中多人时会返回候选列表让你用 userId 重新指定。同时给了 userId 就以 userId 为准。',
} as const;
