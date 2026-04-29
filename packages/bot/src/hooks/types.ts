// Hook type definitions

import type { SendMessageResult } from '@/api/types';
import type { CommandResult, ParsedCommand } from '@/command/types';
import type { MessageSource } from '@/conversation/sources';
import type { ConversationContext } from '@/context/types';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import type { MessageSegment } from '@/message/types';
import type { ToolCall, ToolResult } from '@/tools/types';
import type { HookMetadataMap } from './metadata';

/**
 * Reply content metadata (flags and optional text for history when reply is card image)
 */
export interface ReplyMetadata {
  isCardImage?: boolean; // Flag indicating card image message format
  /** When set (e.g. for card reply), history/context/cache should store this text instead of extracting from segments (LLM-readable; image is only for sending). */
  cardTextForHistory?: string;
  /** When true, pipeline should send this reply as a forward message (Milky only; one card containing the segments). */
  sendAsForward?: boolean;
  // Other flags can be added here in the future
}

/**
 * Reply content structure
 * Represents a reply message with source tracking and metadata
 * All messages are represented as segments, including plain text messages
 */
export interface ReplyContent {
  source: 'command' | 'task' | 'plugin' | 'ai'; // Source of the reply
  segments: MessageSegment[]; // Message segments - the only content field (required)
  metadata?: ReplyMetadata; // Additional reply metadata (flags only, no actual content)
}

/**
 * Hook Context - unified context object passed to all hooks.
 * For message lifecycle: message is set, notice is absent.
 * For notice lifecycle (onNoticeReceived): message is a minimal placeholder for logging, notice is set.
 */
export interface HookContext {
  message: NormalizedMessageEvent;
  context: ConversationContext;
  source: MessageSource; // Origin label — written once by HookContextBuilder.build()
  /** Set when hook is run for a notice event (e.g. onNoticeReceived). */
  notice?: NormalizedNoticeEvent;
  command?: ParsedCommand;
  task?: ToolCall;
  aiResponse?: string;
  result?: ToolResult | CommandResult;
  error?: Error;
  reply?: ReplyContent; // Unified reply content (preferred over metadata 'reply')
  sentMessageResponse?: SendMessageResult; // Full API response from sending message (available in onMessageSent hook after message is sent)
  metadata: HookMetadataMap; // Type-safe metadata map
}

/**
 * Hook result type
 * - true: Continue execution
 * - false: Interrupt execution
 */
export type HookResult = boolean | Promise<boolean>;

/**
 * Hook handler function type
 */
export type HookHandler = (context: HookContext) => HookResult;

/**
 * Hook registration info
 */
export interface HookRegistration {
  hookName: HookName;
  priority: number; // Higher priority = executed first
  handlers: HookHandler[];
}

// Core hook names - only message lifecycle hooks
export type CoreHookName =
  | 'onMessageReceived'
  | 'onMessagePreprocess'
  | 'onMessageBeforeSend'
  | 'onMessageSent'
  | 'onError';

// Extended hook names - can be registered by extensions (command system, task system, etc.)
export type ExtendedHookName = string;

// Hook name union - core hooks are always available, extended hooks are optional
export type HookName = CoreHookName | ExtendedHookName;
