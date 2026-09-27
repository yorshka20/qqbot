// A HookContext for a tool call that does not come from an incoming message —
// a subagent step, or a local coding agent calling a bot tool over MCP. Going
// through ToolManager.execute with one keeps parameter validation and the tool
// hooks (audit ledger, etc.) on the same path as a reply-turn call.

import { deriveSourceFromEvent } from '@/conversation/sources';
import type { NormalizedMessageEvent } from '@/events/types';
import { createDefaultHookMetadata } from './metadata';
import type { HookContext } from './types';

export interface SyntheticTurn {
  id: string;
  timestamp: number;
  protocol: NormalizedMessageEvent['protocol'];
  userId: number;
  /** 0 for a private conversation. */
  groupId: number;
  messageType: 'private' | 'group';
  messageId?: number;
  conversationId?: string;
  /** Stands in for the user message a real turn would carry. */
  messageText: string;
  /** Identifies the caller to hook consumers (e.g. `subAgentSessionId`). */
  contextMetadata: Map<string, unknown>;
}

export function buildSyntheticHookContext(turn: SyntheticTurn): HookContext {
  const isGroup = turn.groupId !== 0;
  const metadata = createDefaultHookMetadata({
    sessionId: isGroup ? `group:${turn.groupId}` : `user:${turn.userId}`,
    sessionType: isGroup ? 'group' : 'user',
    userId: turn.userId,
    groupId: turn.groupId,
    conversationId: turn.conversationId ?? '',
  });

  const message: NormalizedMessageEvent = {
    id: turn.id,
    type: 'message',
    timestamp: turn.timestamp,
    protocol: turn.protocol,
    userId: turn.userId,
    groupId: turn.groupId,
    messageType: turn.messageType,
    message: turn.messageText,
    messageId: turn.messageId,
    segments: [],
  };

  return {
    message,
    context: {
      userMessage: turn.messageText,
      history: [],
      userId: turn.userId,
      groupId: turn.groupId,
      messageType: turn.messageType,
      metadata: turn.contextMetadata,
    },
    metadata,
    source: deriveSourceFromEvent(message),
  };
}
