// Conversation module type definitions

import type { NormalizedMessageEvent } from '@/events/types';
import type { ParsedCommand, CommandResult } from '@/command/types';
import type { Task, TaskResult } from '@/task/types';
import type { ConversationContext } from '@/context/types';

/**
 * Message processing result
 */
export interface MessageProcessingResult {
  success: boolean;
  reply?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Message processing context
 */
export interface MessageProcessingContext {
  message: NormalizedMessageEvent;
  conversationId?: string;
  sessionId: string;
  sessionType: 'user' | 'group';
}
