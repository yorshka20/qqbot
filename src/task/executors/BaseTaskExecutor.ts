// Base task executor - abstract base class for task executors

import type { TaskExecutor, Task, TaskResult, TaskExecutionContext } from '../types';

/**
 * Abstract base class for task executors
 * Provides common functionality and structure
 */
export abstract class BaseTaskExecutor implements TaskExecutor {
  abstract name: string;

  abstract execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> | TaskResult;

  /**
   * Helper method to create success result
   */
  protected success(reply: string, data?: Record<string, unknown>): TaskResult {
    return {
      success: true,
      reply,
      data,
    };
  }

  /**
   * Helper method to create error result
   */
  protected error(reply: string, error: string): TaskResult {
    return {
      success: false,
      reply,
      error,
    };
  }
}
