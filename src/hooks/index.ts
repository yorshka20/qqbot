// Hook types exports

import type { HookContext, HookResult } from './types';
import type { MessageHooks } from './MessageHooks';
import type { CommandHooks } from './CommandHooks';
import type { TaskHooks } from './TaskHooks';
import type { AIHooks } from './AIHooks';

export type { HookContext, HookResult, HookHandler, HookRegistration } from './types';
export type { MessageHooks } from './MessageHooks';
export type { CommandHooks } from './CommandHooks';
export type { TaskHooks } from './TaskHooks';
export type { AIHooks } from './AIHooks';
export { HookPriority, getCoreHookPriority, getExtensionHookPriority } from './HookPriority';
export type { CoreHookName, HookPriorityVariant } from './HookPriority';

/**
 * Combined PluginHooks interface
 * Note: AIHooks are now part of TaskHooks since AI is used as a task executor.
 * AIHooks is kept for backward compatibility but hooks are registered via TaskSystem.
 */
export interface PluginHooks extends MessageHooks, CommandHooks, TaskHooks, AIHooks {
  /**
   * Hook: onError
   * Triggered when an error occurs at any stage
   */
  onError?(context: HookContext): HookResult;
}
