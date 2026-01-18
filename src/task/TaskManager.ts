// Task manager - registers and manages task types and executors

import { getContainer } from '@/core/DIContainer';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { getAllTaskMetadata, metadataToTaskType } from './decorators';
import type { Task, TaskExecutionContext, TaskExecutor, TaskResult, TaskType } from './types';

export class TaskManager {
  private taskTypes = new Map<string, TaskType>();
  private executors = new Map<string, TaskExecutor>();
  private executorClasses = new Map<string, new (...args: any[]) => TaskExecutor>();

  /**
   * Auto-register all decorated tasks
   * Called during initialization
   * Uses lazy instantiation - executors are created on first execution when all dependencies are available
   * Executors provided via registerExecutor() will override lazy instantiation
   */
  autoRegisterDecoratedTasks(): void {
    const metadataList = getAllTaskMetadata();

    for (const metadata of metadataList) {
      try {
        const name = metadata.name.toLowerCase();
        if (this.taskTypes.has(name)) {
          continue;
        }

        // Register task type
        const taskType = metadataToTaskType(metadata);
        this.registerTaskType(taskType);

        // Store executor class for lazy instantiation
        // Only create lazy executor if executor is not already registered
        if (!this.executors.has(metadata.executor.toLowerCase())) {
          this.executorClasses.set(metadata.executor.toLowerCase(), metadata.executorClass);
          this.registerLazyExecutor(metadata.executorClass, metadata.executor);
        }

        logger.info(`✅ [TaskManager] Auto-registered decorated task: ${name} with executor: ${metadata.executor}`);
      } catch (error) {
        logger.error(`[TaskManager] Failed to auto-register task ${metadata.name}:`, error);
      }
    }
  }

  /**
   * Register executor class for lazy instantiation with dependency injection
   * Similar to CommandManager.createLazyHandler
   */
  private registerLazyExecutor(
    executorClass: new (...args: any[]) => TaskExecutor,
    executorName: string,
  ): void {
    let cachedInstance: TaskExecutor | null = null;

    // Helper function to get or create the instance with dependency injection
    const getInstance = (): TaskExecutor => {
      if (cachedInstance) {
        return cachedInstance;
      }

      const container = getContainer();

      // Try to resolve with dependency injection
      try {
        cachedInstance = container.resolve(executorClass);
        logger.debug(`[TaskManager]🎯 Lazy-instantiated ${executorName} with dependency injection`);
        return cachedInstance;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        // Only fallback for executors that truly don't need DI (no constructor params)
        // Otherwise, log error and rethrow to surface dependency issues
        if (executorClass.length === 0) {
          logger.debug(
            `[TaskManager] Falling back to direct instantiation for ${executorName} (no constructor params)`,
          );
          cachedInstance = new executorClass();
          return cachedInstance;
        }

        // If executor has constructor params but DI failed, this is a real error
        logger.error(`[TaskManager] Failed to resolve ${executorName} with DI: ${err.message}`);
        throw new Error(`Failed to instantiate executor ${executorName}: ${err.message}`);
      }
    };

    // Create a lazy executor that will instantiate the executor on first execution
    const lazyExecutor: TaskExecutor = {
      name: executorName,
      execute: async (task: Task, context: TaskExecutionContext) => {
        const executor = getInstance();
        return executor.execute(task, context);
      },
    };

    this.executors.set(executorName.toLowerCase(), lazyExecutor);
  }

  /**
   * Register a task type
   */
  registerTaskType(taskType: TaskType): void {
    const name = taskType.name.toLowerCase();
    this.taskTypes.set(name, taskType);
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
   * This will override any lazy executor that was registered for the same name
   */
  registerExecutor(executor: TaskExecutor): void {
    const name = executor.name.toLowerCase();

    // Remove lazy executor class if exists
    this.executorClasses.delete(name);

    this.executors.set(name, executor);
    logger.info(`⚙️ [TaskManager] Registered executor: ${name}`);
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
    hookManager: HookManager,
    hookContext: HookContext,
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
    const executorName = taskType.executor;
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

    // Hook: onTaskBeforeExecute (if hook manager available)
    // Note: onTaskAnalyzed hook should be called by TaskSystem before calling execute
    const shouldExecute = await hookManager.execute('onTaskBeforeExecute', hookContext);
    if (!shouldExecute) {
      return {
        success: false,
        reply: 'Task execution interrupted by hook',
        error: 'Task execution interrupted by hook',
      };
    }

    try {
      logger.debug(`[TaskManager] Executing task: ${taskType.name} with executor: ${executorName}`);

      const result = await executor.execute(task, context);

      // Update hook context
      hookContext.result = result;

      // Hook: onTaskExecuted (if hook manager available)
      await hookManager.execute('onTaskExecuted', hookContext);

      if (result.success) {
        logger.debug(`[TaskManager] Task ${taskType.name} executed successfully`);
      } else {
        logger.warn(`[TaskManager] Task ${taskType.name} failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[TaskManager] Error executing task ${taskType.name}:`, err);

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
