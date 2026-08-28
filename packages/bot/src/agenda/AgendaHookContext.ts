/**
 * Build a minimal HookContext for agenda-driven tool execution.
 * Allows AgentLoop to use the same tool executor (executeToolCall) as the reply flow.
 */

import type { ConversationContext } from '@/context/types';
import { deriveSourceFromEvent } from '@/conversation/sources';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import { createDefaultHookMetadata } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { AgendaEventContext, AgendaItem } from './types';

/**
 * Chain depth of the item itself (0 for human-created items). Items the LLM
 * registers *during this run* get depth+1, so `agendaChainDepth` in the built
 * context already holds the depth for child registrations.
 */
function resolveChainDepth(item: AgendaItem): number {
  const depth = item.metadata?.chainDepth;
  return typeof depth === 'number' && Number.isFinite(depth) ? depth : 0;
}

export function buildAgendaHookContext(
  item: AgendaItem,
  contextId: string,
  eventContext: AgendaEventContext,
  protocol: ProtocolName = 'milky',
): HookContext {
  const isPrivate = !item.groupId;
  const groupIdNum = isPrivate ? 0 : Number(contextId);
  const userId = Number(item.userId ?? eventContext.userId);
  const botSelfId = eventContext.botSelfId;

  const message: NormalizedMessageEvent = {
    id: `agenda-${item.id}-${Date.now()}`,
    type: 'message',
    timestamp: Date.now(),
    protocol,
    messageType: isPrivate ? 'private' : 'group',
    userId,
    groupId: groupIdNum,
    message: `[日程任务] ${item.name}: ${item.intent}`,
    rawMessage: undefined,
    messageId: undefined,
  };

  const context: ConversationContext = {
    userMessage: message.message,
    history: [],
    userId: message.userId,
    groupId: message.groupId,
    messageType: isPrivate ? 'private' : 'group',
    metadata: new Map(),
  };

  const sessionId = isPrivate ? `private:${userId}` : contextId;
  const metadata = createDefaultHookMetadata({
    sessionId,
    sessionType: isPrivate ? 'user' : 'group',
    conversationId: `agenda-${sessionId}-${item.id}`,
    botSelfId: String(botSelfId ?? 0),
    userId,
    groupId: groupIdNum,
    senderRole: '',
  });
  metadata.set('agendaChainDepth', resolveChainDepth(item) + 1);

  return {
    message,
    context,
    metadata,
    source: deriveSourceFromEvent(message),
  };
}
