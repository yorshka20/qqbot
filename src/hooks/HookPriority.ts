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
 * Core hook priority ranges
 * These define where core hooks execute in the lifecycle
 */
export const HookPriority = {
  // Core message lifecycle hooks
  CORE: {
    // onMessageReceived - first hook, very early
    MESSAGE_RECEIVED: {
      DEFAULT: 500,
      EARLY: 700, // Before default handlers
      LATE: 300, // After default handlers
    },

    // onMessagePreprocess - before processing (command/task/AI)
    MESSAGE_PREPROCESS: {
      DEFAULT: 500,
      EARLY: 700, // Before command routing
      BEFORE_COMMAND: 600, // Right before command detection
      AFTER_COMMAND: 400, // After command detection, before execution
      BEFORE_AI: 300, // Right before AI processing
      LATE: 200, // After most preprocessing
    },

    // onMessageBeforeSend - before sending reply
    MESSAGE_BEFORE_SEND: {
      DEFAULT: 500,
      EARLY: 700, // Before content modification
      CONTENT_MODIFY: 500, // Content modification hooks
      LATE: 300, // After content modification, before sending
    },

    // onMessageSent - after sending reply
    MESSAGE_SENT: {
      DEFAULT: 500,
      EARLY: 700, // Immediate after send
      LATE: 300, // Cleanup hooks
    },

    // onError - error handling
    ERROR: {
      DEFAULT: 1000, // High priority for error handling
      EARLY: 1200, // Critical error handlers
      LATE: 800, // Logging/cleanup error handlers
    },
  },

  // Extension hook priority ranges
  // These define where extension hooks should be inserted
  EXTENSION: {
    // Command system hooks
    COMMAND: {
      DETECTED: {
        DEFAULT: 500,
        BEFORE: 600, // Before command detection logic
        AFTER: 400, // After command detection, before execution
      },
      EXECUTED: {
        DEFAULT: 500,
        BEFORE: 600, // Before result processing
        AFTER: 400, // After result processing
      },
    },

    // Task system hooks
    TASK: {
      ANALYZED: {
        DEFAULT: 500,
        BEFORE: 600, // Before task analysis result processing
        AFTER: 400, // After task analysis result processing
      },
      BEFORE_EXECUTE: {
        DEFAULT: 500,
        BEFORE: 600, // Before executor selection
        AFTER: 400, // After executor selection, before execution
      },
      EXECUTED: {
        DEFAULT: 500,
        BEFORE: 600, // Before result processing
        AFTER: 400, // After result processing
      },
    },

    // AI system hooks
    AI: {
      BEFORE_AI: {
        DEFAULT: 500,
        BEFORE: 600, // Before context building
        AFTER: 400, // After context building, before AI call
      },
      GENERATION_START: {
        DEFAULT: 500,
        BEFORE: 600, // Before prompt preparation
        AFTER: 400, // After prompt preparation, before AI call
      },
      GENERATION_COMPLETE: {
        DEFAULT: 500,
        BEFORE: 600, // Before response parsing
        AFTER: 400, // After response parsing, before task creation
      },
    },
  },
} as const;

/**
 * Get default priority for a core hook
 */
export function getCoreHookPriority(
  hookName: CoreHookName,
  variant:
    | 'DEFAULT'
    | 'EARLY'
    | 'LATE'
    | 'BEFORE_COMMAND'
    | 'AFTER_COMMAND'
    | 'BEFORE_AI'
    | 'CONTENT_MODIFY' = 'DEFAULT',
): number {
  switch (hookName) {
    case 'onMessageReceived':
      return HookPriority.CORE.MESSAGE_RECEIVED[
        variant as 'DEFAULT' | 'EARLY' | 'LATE'
      ];
    case 'onMessagePreprocess':
      return HookPriority.CORE.MESSAGE_PREPROCESS[
        variant as
          | 'DEFAULT'
          | 'EARLY'
          | 'LATE'
          | 'BEFORE_COMMAND'
          | 'AFTER_COMMAND'
          | 'BEFORE_AI'
      ];
    case 'onMessageBeforeSend':
      return HookPriority.CORE.MESSAGE_BEFORE_SEND[
        variant as 'DEFAULT' | 'EARLY' | 'LATE' | 'CONTENT_MODIFY'
      ];
    case 'onMessageSent':
      return HookPriority.CORE.MESSAGE_SENT[
        variant as 'DEFAULT' | 'EARLY' | 'LATE'
      ];
    case 'onError':
      return HookPriority.CORE.ERROR[variant as 'DEFAULT' | 'EARLY' | 'LATE'];
    default:
      return 500;
  }
}

/**
 * Get default priority for an extension hook
 */
export function getExtensionHookPriority(
  hookName: string,
  variant: 'DEFAULT' | 'BEFORE' | 'AFTER' = 'DEFAULT',
): number {
  // Command hooks
  if (hookName === 'onCommandDetected') {
    return HookPriority.EXTENSION.COMMAND.DETECTED[variant];
  }
  if (hookName === 'onCommandExecuted') {
    return HookPriority.EXTENSION.COMMAND.EXECUTED[variant];
  }

  // Task hooks
  if (hookName === 'onTaskAnalyzed') {
    return HookPriority.EXTENSION.TASK.ANALYZED[variant];
  }
  if (hookName === 'onTaskBeforeExecute') {
    return HookPriority.EXTENSION.TASK.BEFORE_EXECUTE[variant];
  }
  if (hookName === 'onTaskExecuted') {
    return HookPriority.EXTENSION.TASK.EXECUTED[variant];
  }

  // AI hooks
  if (hookName === 'onMessageBeforeAI') {
    return HookPriority.EXTENSION.AI.BEFORE_AI[variant];
  }
  if (hookName === 'onAIGenerationStart') {
    return HookPriority.EXTENSION.AI.GENERATION_START[variant];
  }
  if (hookName === 'onAIGenerationComplete') {
    return HookPriority.EXTENSION.AI.GENERATION_COMPLETE[variant];
  }

  // Default for unknown extension hooks
  return 500;
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

/**
 * Hook priority variant type for core hooks
 */
export type HookPriorityVariant =
  | 'DEFAULT'
  | 'EARLY'
  | 'LATE'
  | 'BEFORE_COMMAND'
  | 'AFTER_COMMAND'
  | 'BEFORE_AI'
  | 'CONTENT_MODIFY';
