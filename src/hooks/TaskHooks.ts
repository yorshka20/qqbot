// Task-related hook types

import type { HookContext, HookResult } from './types';

/**
 * Task-related hooks
 * Note: AI-related hooks (onMessageBeforeAI, onAIGenerationStart, onAIGenerationComplete)
 * are also part of task execution, as AI is used as a task executor.
 * These hooks are registered by TaskSystem and triggered during task execution.
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

  /**
   * Hook: onMessageBeforeAI
   * Triggered before AI processing during task execution
   * Part of task execution flow when AI is used as executor
   */
  onMessageBeforeAI?(context: HookContext): HookResult;

  /**
   * Hook: onAIGenerationStart
   * Triggered when AI generation starts during task execution
   * Part of task execution flow when AI is used as executor
   */
  onAIGenerationStart?(context: HookContext): HookResult;

  /**
   * Hook: onAIGenerationComplete
   * Triggered when AI generation completes during task execution
   * Part of task execution flow when AI is used as executor
   */
  onAIGenerationComplete?(context: HookContext): HookResult;
}
