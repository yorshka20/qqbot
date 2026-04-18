// AI-related hook types

import type { HookContext, HookResult } from './types';

/**
 * AI-related hooks
 */
export interface AIHooks {
  /**
   * Hook: onMessageBeforeAI
   * Triggered before AI processing, after context is built
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
