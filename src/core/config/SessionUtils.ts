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
