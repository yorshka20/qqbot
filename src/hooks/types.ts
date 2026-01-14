// Hook type definitions

import type { CommandResult, ParsedCommand } from '@/command/types';
import type { ConversationContext } from '@/context/types';
import type { NormalizedMessageEvent } from '@/events/types';
import type { Task, TaskResult } from '@/task/types';

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
  metadata: Map<string, unknown>;
}

/**
 * Hook result type
 * - void/undefined: Continue execution
 * - true: Continue execution
 * - false: Interrupt execution
 */
export type HookResult = void | boolean | Promise<void | boolean>;

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
