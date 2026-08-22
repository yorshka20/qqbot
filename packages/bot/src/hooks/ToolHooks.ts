// Tool-execution hook types

import type { HookContext, HookResult } from './types';

/**
 * Tool-execution hooks, fired by ToolManager.execute around every tool call.
 * The context passed to these hooks carries `toolCall` (and `result` after
 * execution) on a per-call copy — see ToolManager.execute.
 *
 * Note: AI-related hooks (onMessageBeforeAI, onAIGenerationStart,
 * onAIGenerationComplete) are also part of the generation flow and live here
 * alongside tool hooks.
 */
export interface ToolHooks {
  /**
   * Hook: onToolBeforeExecute
   * Triggered before a tool call executes. Returning false blocks the call.
   */
  onToolBeforeExecute?(context: HookContext): HookResult;

  /**
   * Hook: onToolExecuted
   * Triggered after a tool call completes; `context.result` carries the ToolResult.
   */
  onToolExecuted?(context: HookContext): HookResult;

  /**
   * Hook: onMessageBeforeAI
   * Triggered before AI processing during reply generation
   */
  onMessageBeforeAI?(context: HookContext): HookResult;

  /**
   * Hook: onAIGenerationStart
   * Triggered when AI generation starts
   */
  onAIGenerationStart?(context: HookContext): HookResult;

  /**
   * Hook: onAIGenerationComplete
   * Triggered when AI generation completes
   */
  onAIGenerationComplete?(context: HookContext): HookResult;
}
