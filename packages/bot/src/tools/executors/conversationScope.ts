// Which conversation a tool should read from, derived from the turn it runs in.
//
// Group and 1:1 turns persist under different session keys (`group:<id>` vs
// `user:<id>`, see ConversationManager.getSessionId), so a tool that hardwires
// `'group'` silently has no data in a private chat — and the history tools used
// to fail outright there while still advertising `qq-private`.

import { normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import type { ToolExecutionContext } from '../types';

export interface ConversationScope {
  sessionId: string;
  sessionType: 'group' | 'user';
  /** Present only for group turns; the memory store and group APIs are keyed by it. */
  groupId?: string;
}

/**
 * Resolve the conversation a tool should operate on. Returns null when the turn
 * carries neither a group nor a user id — a background or reflection run with no
 * live conversation, where "search this chat" has no referent.
 */
export function resolveConversationScope(context: ToolExecutionContext): ConversationScope | null {
  if (context.groupId) {
    const { sessionId, groupIdNum } = normalizeGroupId(context.groupId);
    return { sessionId, sessionType: 'group', groupId: String(groupIdNum) };
  }
  if (context.messageType === 'private' && context.userId) {
    return { sessionId: `user:${context.userId}`, sessionType: 'user' };
  }
  return null;
}
