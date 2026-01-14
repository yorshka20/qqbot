// Hook Priority Constants
// Defines priority ranges for different hook stages to ensure correct execution order

/**
 * Hook Priority Constants
 *
 * Priority ranges:
 * - Higher number = executed earlier
 * - Core hooks have fixed priority ranges
 * - Extension hooks should use priority values within appropriate ranges
 *
 * Priority ranges:
 * - 1000+: Very early (system-level hooks)
 * - 500-999: Early (pre-processing)
 * - 100-499: Normal (main processing)
 * - 0-99: Late (post-processing)
 * - Negative: Very late (cleanup)
 */

/**
 * Hook priority variant type
 * Five priority levels within a hook stage (not related to hook name timing)
 * Priority order: HIGHEST > HIGH > NORMAL > LOW > LOWEST
 * Higher number = executed earlier within the same hook stage
 */
export type HookPriorityVariant = 'HIGHEST' | 'HIGH' | 'NORMAL' | 'LOW' | 'LOWEST';

/**
 * Standard priority configuration for most hooks
 */
const STANDARD_PRIORITIES: Record<HookPriorityVariant, number> = {
  HIGHEST: 700,
  HIGH: 600,
  NORMAL: 500,
  LOW: 400,
  LOWEST: 300,
};

/**
 * Error hook priority configuration (higher priority for error handling)
 */
const ERROR_PRIORITIES: Record<HookPriorityVariant, number> = {
  HIGHEST: 1200,
  HIGH: 1100,
  NORMAL: 1000,
  LOW: 900,
  LOWEST: 800,
};

/**
 * Core hook priority ranges
 * These define where core hooks execute in the lifecycle
 */
export const HookPriority: Record<
  string,
  Record<string, Partial<Record<HookPriorityVariant, number>> & { NORMAL: number }>
> = {
  // Core message lifecycle hooks
  CORE: {
    // onMessageReceived - when message is received
    MESSAGE_RECEIVED: STANDARD_PRIORITIES,

    // onMessagePreprocess - before message preprocessing
    MESSAGE_PREPROCESS: STANDARD_PRIORITIES,

    // onMessageBeforeSend - before sending reply
    MESSAGE_BEFORE_SEND: STANDARD_PRIORITIES,

    // onMessageSent - after sending reply
    MESSAGE_SENT: STANDARD_PRIORITIES,

    // onError - error handling (higher priority)
    ERROR: ERROR_PRIORITIES,
  },

  // Command system hooks
  COMMAND: {
    DETECTED: STANDARD_PRIORITIES,
    EXECUTED: STANDARD_PRIORITIES,
  },

  // Task system hooks
  TASK: {
    ANALYZED: STANDARD_PRIORITIES,
    BEFORE_EXECUTE: STANDARD_PRIORITIES,
    EXECUTED: STANDARD_PRIORITIES,
  },

  // AI system hooks
  AI: {
    BEFORE_AI: STANDARD_PRIORITIES,
    GENERATION_START: STANDARD_PRIORITIES,
    GENERATION_COMPLETE: STANDARD_PRIORITIES,
  },
} as const;

/**
 * Get priority for a hook (core or extension)
 * @param hookName - Hook name
 * @param variant - Priority variant (defaults to NORMAL)
 * @returns Priority number (higher = executed earlier within the same hook stage)
 */
export function getHookPriority(hookName: string, variant: HookPriorityVariant = 'NORMAL'): number {
  // Core hooks
  switch (hookName) {
    case 'onMessageReceived': {
      const priority = HookPriority.CORE.MESSAGE_RECEIVED[variant];
      return priority ?? HookPriority.CORE.MESSAGE_RECEIVED.NORMAL;
    }
    case 'onMessagePreprocess': {
      const priority = HookPriority.CORE.MESSAGE_PREPROCESS[variant];
      return priority ?? HookPriority.CORE.MESSAGE_PREPROCESS.NORMAL;
    }
    case 'onMessageBeforeSend': {
      const priority = HookPriority.CORE.MESSAGE_BEFORE_SEND[variant];
      return priority ?? HookPriority.CORE.MESSAGE_BEFORE_SEND.NORMAL;
    }
    case 'onMessageSent': {
      const priority = HookPriority.CORE.MESSAGE_SENT[variant];
      return priority ?? HookPriority.CORE.MESSAGE_SENT.NORMAL;
    }
    case 'onError': {
      const priority = HookPriority.CORE.ERROR[variant];
      return priority ?? HookPriority.CORE.ERROR.NORMAL;
    }
  }

  // Command hooks
  if (hookName === 'onCommandDetected') {
    const priority = HookPriority.COMMAND.DETECTED[variant];
    return priority ?? HookPriority.COMMAND.DETECTED.NORMAL;
  }
  if (hookName === 'onCommandExecuted') {
    const priority = HookPriority.COMMAND.EXECUTED[variant];
    return priority ?? HookPriority.COMMAND.EXECUTED.NORMAL;
  }

  // Task hooks
  if (hookName === 'onTaskAnalyzed') {
    const priority = HookPriority.TASK.ANALYZED[variant];
    return priority ?? HookPriority.TASK.ANALYZED.NORMAL;
  }
  if (hookName === 'onTaskBeforeExecute') {
    const priority = HookPriority.TASK.BEFORE_EXECUTE[variant];
    return priority ?? HookPriority.TASK.BEFORE_EXECUTE.NORMAL;
  }
  if (hookName === 'onTaskExecuted') {
    const priority = HookPriority.TASK.EXECUTED[variant];
    return priority ?? HookPriority.TASK.EXECUTED.NORMAL;
  }

  // AI hooks
  if (hookName === 'onMessageBeforeAI') {
    const priority = HookPriority.AI.BEFORE_AI[variant];
    return priority ?? HookPriority.AI.BEFORE_AI.NORMAL;
  }
  if (hookName === 'onAIGenerationStart') {
    const priority = HookPriority.AI.GENERATION_START[variant];
    return priority ?? HookPriority.AI.GENERATION_START.NORMAL;
  }
  if (hookName === 'onAIGenerationComplete') {
    const priority = HookPriority.AI.GENERATION_COMPLETE[variant];
    return priority ?? HookPriority.AI.GENERATION_COMPLETE.NORMAL;
  }

  // Unknown hook - use standard priority
  return STANDARD_PRIORITIES.NORMAL;
}

/**
 * Core hook name type
 */
export type CoreHookName =
  | 'onMessageReceived'
  | 'onMessagePreprocess'
  | 'onMessageBeforeSend'
  | 'onMessageSent'
  | 'onError';
