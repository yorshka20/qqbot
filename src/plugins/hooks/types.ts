// Hook type definitions

import type { NormalizedMessageEvent } from '@/events/types';
import type { ParsedCommand, CommandResult } from '@/command/types';
import type { Task, TaskResult } from '@/task/types';
import type { ConversationContext } from '@/context/types';

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
  handler: HookHandler;
  priority: number; // Higher priority = executed first
  pluginName?: string;
}
