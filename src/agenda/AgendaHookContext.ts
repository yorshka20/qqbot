/**
 * Build a minimal HookContext for agenda-driven tool execution.
 * Allows AgentLoop to use the same tool executor (executeToolCall) as the reply flow.
 */

import type { ConversationContext } from '@/context/types';
import type { NormalizedMessageEvent } from '@/events/types';
import { createDefaultHookMetadata } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { AgendaEventContext, AgendaItem } from './types';

export function buildAgendaHookContext(
  item: AgendaItem,
  groupId: string,
  eventContext: AgendaEventContext,
): HookContext {
  const groupIdNum = Number(groupId);
  const userId = Number(eventContext.userId);
  const botSelfId = eventContext.botSelfId;

  const message: NormalizedMessageEvent = {
    id: `agenda-${item.id}-${Date.now()}`,
    type: 'message',
    timestamp: Date.now(),
    protocol: 'milky',
    messageType: 'group',
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
    messageType: 'group',
    metadata: new Map(),
  };

  const metadata = createDefaultHookMetadata({
    sessionId: groupId,
    sessionType: 'group',
    conversationId: `agenda-${groupId}-${item.id}`,
    botSelfId: String(botSelfId ?? 0),
    userId,
    groupId: groupIdNum,
    senderRole: '',
  });

  return {
    message,
    context,
    metadata,
  };
}
