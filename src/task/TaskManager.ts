// Task manager - registers and manages task types and executors

import type { HookManager } from '@/hooks/HookManager';
import { MetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import type { Task, TaskExecutionContext, TaskExecutor, TaskResult, TaskType } from './types';

export class TaskManager {
  private taskTypes = new Map<string, TaskType>();
  private executors = new Map<string, TaskExecutor>();
  private hookManager: HookManager | null = null;

  /**
   * Set hook manager for extension hooks
   * Note: Task hooks (onTaskAnalyzed, onTaskBeforeExecute, onTaskExecuted, etc.) are registered
   * by TaskSystem via getExtensionHooks() method, not here.
   */
  setHookManager(hookManager: HookManager): void {
    this.hookManager = hookManager;
  }

  /**
   * Register a task type
   */
  registerTaskType(taskType: TaskType): void {
    const name = taskType.name.toLowerCase();

    if (this.taskTypes.has(name)) {
      logger.warn(`[TaskManager] Task type "${name}" already registered, overwriting...`);
    }

    this.taskTypes.set(name, taskType);
    logger.info(`[TaskManager] Registered task type: ${name}`);
  }

  /**
   * Register multiple task types
   */
  registerTaskTypes(taskTypes: TaskType[]): void {
    for (const taskType of taskTypes) {
      this.registerTaskType(taskType);
    }
  }

  /**
   * Get task type by name
   */
  getTaskType(name: string): TaskType | null {
    return this.taskTypes.get(name.toLowerCase()) || null;
  }

  /**
   * Get all task types
   */
  getAllTaskTypes(): TaskType[] {
    return Array.from(this.taskTypes.values());
  }

  /**
   * Register a task executor
   */
  registerExecutor(executor: TaskExecutor): void {
    const name = executor.name.toLowerCase();

    if (this.executors.has(name)) {
      logger.warn(`[TaskManager] Executor "${name}" already registered, overwriting...`);
    }

    this.executors.set(name, executor);
    logger.info(`[TaskManager] Registered executor: ${name}`);
  }

  /**
   * Get executor by name
   */
  getExecutor(name: string): TaskExecutor | null {
    return this.executors.get(name.toLowerCase()) || null;
  }

  /**
   * Execute task
   * Handles task extension hooks internally
   */
  async execute(
    task: Task,
    context: TaskExecutionContext,
    hookManager?: HookManager,
    hookContext?: HookContext,
  ): Promise<TaskResult> {
    // Validate task type
    const taskType = this.getTaskType(task.type);
    if (!taskType) {
      return {
        success: false,
        reply: `Unknown task type: ${task.type}`,
        error: `Task type "${task.type}" not found`,
      };
    }

    // Get executor
    const executorName = task.executor || taskType.executor;
    const executor = this.getExecutor(executorName);

    if (!executor) {
      return {
        success: false,
        reply: `Executor not found: ${executorName}`,
        error: `Executor "${executorName}" not found`,
      };
    }

    // Validate parameters if task type defines them
    if (taskType.parameters) {
      const validationError = this.validateParameters(task.parameters, taskType.parameters);
      if (validationError) {
        return {
          success: false,
          reply: `Invalid task parameters: ${validationError}`,
          error: validationError,
        };
      }
    }

    // Use provided hookManager or internal one
    const hm = hookManager || this.hookManager;
    const hc: HookContext = hookContext || {
      message: {} as any, // Temporary context for task execution
      task,
      metadata: new MetadataMap(),
    };

    // Hook: onTaskBeforeExecute (if hook manager available)
    // Note: onTaskAnalyzed hook should be called by TaskSystem before calling execute
    if (hm && hc) {
      const shouldExecute = await hm.execute('onTaskBeforeExecute', hc);
      if (!shouldExecute) {
        return {
          success: false,
          reply: 'Task execution interrupted by hook',
          error: 'Task execution interrupted by hook',
        };
      }
    }

    try {
      logger.debug(`[TaskManager] Executing task: ${task.type} with executor: ${executorName}`);

      const result = await executor.execute(task, context);

      // Update hook context
      if (hc) {
        hc.result = result;
      }

      // Hook: onTaskExecuted (if hook manager available)
      if (hm && hc) {
        await hm.execute('onTaskExecuted', hc);
      }

      if (result.success) {
        logger.debug(`[TaskManager] Task ${task.type} executed successfully`);
      } else {
        logger.warn(`[TaskManager] Task ${task.type} failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[TaskManager] Error executing task ${task.type}:`, err);

      return {
        success: false,
        reply: `Task execution failed: ${err.message}`,
        error: err.message,
      };
    }
  }

  /**
   * Validate task parameters against task type definition
   */
  private validateParameters(
    parameters: Record<string, unknown>,
    parameterDefs: TaskType['parameters'],
  ): string | null {
    if (!parameterDefs) {
      return null;
    }

    for (const [key, def] of Object.entries(parameterDefs)) {
      if (def.required && !(key in parameters)) {
        return `Missing required parameter: ${key}`;
      }

      if (key in parameters) {
        const value = parameters[key];
        const expectedType = def.type;

        // Basic type checking
        if (expectedType === 'string' && typeof value !== 'string') {
          return `Parameter ${key} must be a string`;
        }
        if (expectedType === 'number' && typeof value !== 'number') {
          return `Parameter ${key} must be a number`;
        }
        if (expectedType === 'boolean' && typeof value !== 'boolean') {
          return `Parameter ${key} must be a boolean`;
        }
        if (expectedType === 'object' && (typeof value !== 'object' || value === null)) {
          return `Parameter ${key} must be an object`;
        }
        if (expectedType === 'array' && !Array.isArray(value)) {
          return `Parameter ${key} must be an array`;
        }
      }
    }

    return null;
  }
}
