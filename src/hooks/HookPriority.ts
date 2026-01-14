// Hook Priority Constants
// Defines priority ranges for different hook stages to ensure correct execution order

/**
 * Hook Priority Constants
 *
 * Priority ranges:
 * - Lower number = executed earlier
 * - Core hooks have fixed priority ranges
 * - Extension hooks should use priority values within appropriate ranges
 *
 * Priority ranges (lower number = executed earlier):
 * - 0-399: Very early (system-level hooks)
 * - 400-699: Early (pre-processing)
 * - 700-999: Normal (main processing)
 * - 1000+: Late (post-processing)
 */

/**
 * Hook priority variant type
 * Five priority levels within a hook stage (not related to hook name timing)
 * Priority order: HIGHEST > HIGH > NORMAL > LOW > LOWEST
 * Lower number = executed earlier within the same hook stage
 */
export type HookPriorityVariant = 'HIGHEST' | 'HIGH' | 'NORMAL' | 'LOW' | 'LOWEST';

/**
 * Standard priority configuration for most hooks
 */
const STANDARD_PRIORITIES: Record<HookPriorityVariant, number> = {
  HIGHEST: 0,
  HIGH: 300,
  NORMAL: 500,
  LOW: 700,
  LOWEST: 900,
};

/**
 * Error hook priority configuration (higher priority for error handling)
 */
const ERROR_PRIORITIES: Record<HookPriorityVariant, number> = {
  HIGHEST: 600,
  HIGH: 900,
  NORMAL: 1000,
  LOW: 1100,
  LOWEST: 1200,
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
 * @param order - Order (defaults to 0)
 * @returns Priority number (lower = executed earlier within the same hook stage)
 */
export function getHookPriority(hookName: string, variant: HookPriorityVariant, order: number = 0): number {
  let priority = STANDARD_PRIORITIES.NORMAL;

  // Core hooks
  switch (hookName) {
    case 'onMessageReceived': {
      priority = HookPriority.CORE.MESSAGE_RECEIVED[variant] ?? HookPriority.CORE.MESSAGE_RECEIVED.NORMAL;
    }
    case 'onMessagePreprocess': {
      priority = HookPriority.CORE.MESSAGE_PREPROCESS[variant] ?? HookPriority.CORE.MESSAGE_PREPROCESS.NORMAL;
    }
    case 'onMessageBeforeSend': {
      priority = HookPriority.CORE.MESSAGE_BEFORE_SEND[variant] ?? HookPriority.CORE.MESSAGE_BEFORE_SEND.NORMAL;
    }
    case 'onMessageSent': {
      priority = HookPriority.CORE.MESSAGE_SENT[variant] ?? HookPriority.CORE.MESSAGE_SENT.NORMAL;
    }
    case 'onError': {
      priority = HookPriority.CORE.ERROR[variant] ?? HookPriority.CORE.ERROR.NORMAL;
    }
  }

  // Command hooks
  if (hookName === 'onCommandDetected') {
    priority = HookPriority.COMMAND.DETECTED[variant] ?? HookPriority.COMMAND.DETECTED.NORMAL;
  }
  if (hookName === 'onCommandExecuted') {
    priority = HookPriority.COMMAND.EXECUTED[variant] ?? HookPriority.COMMAND.EXECUTED.NORMAL;
  }

  // Task hooks
  if (hookName === 'onTaskAnalyzed') {
    priority = HookPriority.TASK.ANALYZED[variant] ?? HookPriority.TASK.ANALYZED.NORMAL;
  }
  if (hookName === 'onTaskBeforeExecute') {
    priority = HookPriority.TASK.BEFORE_EXECUTE[variant] ?? HookPriority.TASK.BEFORE_EXECUTE.NORMAL;
  }
  if (hookName === 'onTaskExecuted') {
    priority = HookPriority.TASK.EXECUTED[variant] ?? HookPriority.TASK.EXECUTED.NORMAL;
  }

  // AI hooks
  if (hookName === 'onMessageBeforeAI') {
    priority = HookPriority.AI.BEFORE_AI[variant] ?? HookPriority.AI.BEFORE_AI.NORMAL;
  }
  if (hookName === 'onAIGenerationStart') {
    priority = HookPriority.AI.GENERATION_START[variant] ?? HookPriority.AI.GENERATION_START.NORMAL;
  }
  if (hookName === 'onAIGenerationComplete') {
    priority = HookPriority.AI.GENERATION_COMPLETE[variant] ?? HookPriority.AI.GENERATION_COMPLETE.NORMAL;
  }

  // Unknown hook - use standard priority
  return priority + order;
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
