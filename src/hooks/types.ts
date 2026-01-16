// Hook type definitions

import type { CommandResult, ParsedCommand } from '@/command/types';
import type { ConversationContext } from '@/context/types';
import type { NormalizedMessageEvent } from '@/events/types';
import type { Task, TaskResult } from '@/task/types';
import type { MetadataMap } from './metadata';

/**
 * Reply content metadata
 */
export interface ReplyMetadata {
  cardImage?: string; // Base64-encoded image data
  isCardImage?: boolean; // Flag indicating card image message format
}

/**
 * Reply content structure
 * Represents a reply message with source tracking and metadata
 */
export interface ReplyContent {
  text: string; // The reply message text content
  source: 'command' | 'task' | 'plugin' | 'ai'; // Source of the reply
  metadata?: ReplyMetadata; // Additional reply metadata (images, formatting, etc.)
}

/**
 * Hook Context - unified context object passed to all hooks
 */
export interface HookContext {
  message: NormalizedMessageEvent;
  command?: ParsedCommand;
  task?: Task;
  aiResponse?: string;
  context?: ConversationContext;
  result?: TaskResult | CommandResult;
  error?: Error;
  reply?: ReplyContent; // Unified reply content (preferred over metadata 'reply')
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
