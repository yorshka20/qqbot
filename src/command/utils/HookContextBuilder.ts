// HookContext builder utility for command handlers
// Provides unified way to create HookContext from CommandContext

import { HookContextBuilder as BaseHookContextBuilder } from '@/context/HookContextBuilder';
import type { HookContext } from '@/hooks/types';
import type { CommandContext } from '../types';

/**
 * Create hook context for command execution with custom message
 * This utility function allows command handlers to create HookContext
 * with a different message (e.g., processed prompt) than the original command message
 * 
 * @param context - CommandContext with conversationContext already built
 * @param message - Custom message content (e.g., processed prompt)
 * @returns HookContext ready for use with AIService
 */
export function createHookContextForCommand(context: CommandContext, message: string): HookContext {
  const protocol = context.metadata.protocol;
  const sessionId = context.groupId ? `group_${context.groupId}` : `user_${context.userId}`;
  const sessionType = context.messageType === 'private' ? 'user' : context.messageType;

  // Use conversation context from CommandContext (already built in MessagePipeline)
  return BaseHookContextBuilder.create()
    .withSyntheticMessage({
      id: `cmd_${Date.now()}`,
      type: 'message',
      timestamp: Date.now(),
      protocol,
      userId: context.userId,
      groupId: context.groupId,
      messageId: undefined,
      messageType: context.messageType,
      message,
      segments: [],
    })
    .withMetadata('sessionId', sessionId)
    .withMetadata('sessionType', sessionType)
    .withConversationContext(context.conversationContext)
    .build();
}
