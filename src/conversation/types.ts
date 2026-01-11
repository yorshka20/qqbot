// Conversation module type definitions

import type { NormalizedMessageEvent } from '@/events/types';

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
  botSelfId: string;
}
