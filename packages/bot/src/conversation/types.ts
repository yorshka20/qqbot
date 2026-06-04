// Conversation module type definitions

import type { NormalizedMessageEvent } from '@/events/types';
import type { MessageSource } from './sources';

/**
 * Message processing result
 */
export interface MessageProcessingResult {
  success: boolean;
  reply?: string;
  error?: string;
  /** True when the message was discarded because another message for the same session
   * was still in flight (source concurrency === 'drop'). No LLM call was made. */
  dropped?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Options for processMessage when the reply is triggered by something other than @bot (e.g. reaction).
 * Passed via MessageProcessingContext into pipeline metadata.
 */
export interface ProcessMessageOptions {
  /** When 'reaction', pipeline allows reply for group without @bot (e.g. MessageOperationPlugin reply operation). */
  replyTrigger?: 'at' | 'reaction';
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
  /** Propagated to hook context metadata; used by WhitelistPlugin to allow reply without @bot. */
  replyTrigger?: 'at' | 'reaction';
  source: MessageSource; // Origin label for hook filtering
  /** Caller-provided callback invoked when sourceConfig.responseHandler === 'callback' (e.g. avatar-cmd).
   * Receives the final ReplyContent. The pipeline does NOT send to IM in this case. */
  responseCallback?: (reply: import('@/hooks/types').ReplyContent) => void;
}
