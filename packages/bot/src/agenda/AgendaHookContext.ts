/**
 * Build a minimal HookContext for agenda-driven tool execution.
 * Allows AgentLoop to use the same tool executor (executeToolCall) as the reply flow.
 */

import type { ConversationContext } from '@/context/types';
import { deriveSourceFromEvent } from '@/conversation/sources';
import type { NormalizedMessageEvent } from '@/events/types';
import { createDefaultHookMetadata } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { AgendaEventContext, AgendaItem } from './types';

export function buildAgendaHookContext(
  item: AgendaItem,
  contextId: string,
  eventContext: AgendaEventContext,
): HookContext {
  const isPrivate = !item.groupId;
  const groupIdNum = isPrivate ? 0 : Number(contextId);
  const userId = Number(item.userId ?? eventContext.userId);
  const botSelfId = eventContext.botSelfId;

  const message: NormalizedMessageEvent = {
    id: `agenda-${item.id}-${Date.now()}`,
    type: 'message',
    timestamp: Date.now(),
    protocol: 'milky',
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

  return {
    message,
    context,
    metadata,
    source: deriveSourceFromEvent(message),
  };
}
