// Session utilities - helper functions for determining session ID and type

import type { CommandContext } from '@/command/types';

/**
 * Get session ID from command context
 * For private/temp sessions: uses userId
 * For group sessions: uses groupId
 */
export function getSessionId(context: CommandContext): string {
  // Temporary sessions should use userId (same as private chat)
  if (context.messageScene === 'temp') {
    return context.userId.toString();
  }

  // Group sessions use groupId
  if (context.messageType === 'group' && context.groupId !== undefined) {
    return context.groupId.toString();
  }

  // Private sessions use userId
  return context.userId.toString();
}

/**
 * Get session type from command context
 * Temporary sessions are treated as 'user' type (same as private chat)
 */
export function getSessionType(context: CommandContext): 'user' | 'group' {
  // Temporary sessions should use 'user' type (same as private chat)
  if (context.messageScene === 'temp') {
    return 'user';
  }

  // Group sessions
  if (context.messageType === 'group') {
    return 'group';
  }

  // Private sessions
  return 'user';
}

/**
 * Convert a pipeline session id to the form ConversationConfigService is keyed on.
 *
 * Pipeline metadata and `ReplyPipelineContext.sessionId` carry the canonical
 * prefixed id (`"group:111"` / `"user:222"`), while ConversationConfigService and
 * every `/`-command write through {@link getSessionId}, which is the bare id.
 * Reading config with a prefixed id silently misses and looks like "the setting
 * never took effect", so normalize before any getConfig / get* lookup.
 */
export function normalizeSessionForConfig(
  rawSessionId: string,
  sessionType: 'user' | 'group',
): { sessionId: string; sessionType: 'user' | 'group' } {
  if (rawSessionId.startsWith('group:')) {
    return { sessionId: rawSessionId.slice('group:'.length), sessionType: 'group' };
  }
  if (rawSessionId.startsWith('user:')) {
    return { sessionId: rawSessionId.slice('user:'.length), sessionType: 'user' };
  }
  return { sessionId: rawSessionId, sessionType };
}
