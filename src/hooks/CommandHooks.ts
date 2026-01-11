// Command-related hook types

import type { HookContext, HookResult } from './types';

/**
 * Command-related hooks
 */
export interface CommandHooks {
  /**
   * Hook: onCommandDetected
   * Triggered when a command is detected
   */
  onCommandDetected?(context: HookContext): HookResult;

  /**
   * Hook: onCommandExecuted
   * Triggered after command execution completes
   */
  onCommandExecuted?(context: HookContext): HookResult;
}
