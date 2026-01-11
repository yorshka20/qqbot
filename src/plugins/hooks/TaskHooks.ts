// Task-related hook types

import type { HookContext, HookResult } from './types';

/**
 * Task-related hooks
 */
export interface TaskHooks {
  /**
   * Hook: onTaskAnalyzed
   * Triggered when task analysis completes
   */
  onTaskAnalyzed?(context: HookContext): HookResult;

  /**
   * Hook: onTaskBeforeExecute
   * Triggered before task execution
   */
  onTaskBeforeExecute?(context: HookContext): HookResult;

  /**
   * Hook: onTaskExecuted
   * Triggered after task execution completes
   */
  onTaskExecuted?(context: HookContext): HookResult;
}
