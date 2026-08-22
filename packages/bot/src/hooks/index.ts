// Hook types exports

import type { AIHooks } from './AIHooks';
import type { CommandHooks } from './CommandHooks';
import type { MessageHooks } from './MessageHooks';
import type { ToolHooks } from './ToolHooks';
import type { HookContext, HookResult } from './types';

export type { AIHooks } from './AIHooks';
export type { CommandHooks } from './CommandHooks';
export type { CoreHookName, HookPriorityVariant } from './HookPriority';
export { getHookPriority, HookPriority } from './HookPriority';
export type { MessageHooks } from './MessageHooks';
export type { ToolHooks } from './ToolHooks';
export type { HookContext, HookHandler, HookRegistration, HookResult } from './types';

/**
 * Combined PluginHooks interface
 * Note: AIHooks are now part of ToolHooks since AI is used inside the tool/generation flow.
 * AIHooks is kept for backward compatibility but hooks are registered via reply orchestration.
 */
export interface PluginHooks extends MessageHooks, CommandHooks, ToolHooks, AIHooks {
  /**
   * Hook: onError
   * Triggered when an error occurs at any stage
   */
  onError?(context: HookContext): HookResult;
}
