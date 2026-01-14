// Hook types exports

import type { AIHooks } from './AIHooks';
import type { CommandHooks } from './CommandHooks';
import type { MessageHooks } from './MessageHooks';
import type { TaskHooks } from './TaskHooks';
import type { HookContext, HookResult } from './types';

export type { AIHooks } from './AIHooks';
export type { CommandHooks } from './CommandHooks';
export { getHookPriority, HookPriority } from './HookPriority';
export type { CoreHookName, HookPriorityVariant } from './HookPriority';
export type { MessageHooks } from './MessageHooks';
export type { TaskHooks } from './TaskHooks';
export type { HookContext, HookHandler, HookRegistration, HookResult } from './types';

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
