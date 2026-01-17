// Hook type definitions

import type { SendMessageResult } from '@/api/methods/MessageAPI';
import type { CommandResult, ParsedCommand } from '@/command/types';
import type { ConversationContext } from '@/context/types';
import type { NormalizedMessageEvent } from '@/events/types';
import { MessageSegment } from '@/message/types';
import type { Task, TaskResult } from '@/task/types';
import type { MetadataMap } from './metadata';

/**
 * Reply content metadata (flags only, no actual content)
 */
export interface ReplyMetadata {
  isCardImage?: boolean; // Flag indicating card image message format
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
 * Hook Context - unified context object passed to all hooks
 */
export interface HookContext {
  message: NormalizedMessageEvent;
  context: ConversationContext;
  command?: ParsedCommand;
  task?: Task;
  aiResponse?: string;
  result?: TaskResult | CommandResult;
  error?: Error;
  reply?: ReplyContent; // Unified reply content (preferred over metadata 'reply')
  sentMessageResponse?: SendMessageResult; // Full API response from sending message (available in onMessageSent hook after message is sent)
  metadata: MetadataMap; // Type-safe metadata map
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
