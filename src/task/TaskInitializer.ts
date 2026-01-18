// Task Initializer - initializes task system and loads task executors

// Import all task executors to ensure decorators are executed
import '@/task/executors';

import { logger } from '@/utils/logger';
import { readdirSync } from 'fs';
import { extname, join } from 'path';
import { getAllTaskMetadata } from './decorators';
import type { TaskManager } from './TaskManager';
import type { TaskExecutor } from './types';

/**
 * Task Initializer
 * Initializes TaskManager and loads task executors
 */
export class TaskInitializer {
  /**
   * Initialize task system
   * Loads all decorated task executors and registers them
   *
   * @param taskManager - Task manager instance
   * @param executorInstances - Optional map of executor instances (for executors that need dependencies)
   */
  static initialize(taskManager: TaskManager, executorInstances?: Map<string, TaskExecutor>): void {
    logger.info('📋 [TaskInitializer] Starting initialization...');

    // Auto-register all decorated tasks
    taskManager.autoRegisterDecoratedTasks();

    // Register executor instances if provided
    if (executorInstances) {
      for (const [name, executor] of executorInstances.entries()) {
        taskManager.registerExecutor(executor);
        logger.info(`✅ [TaskInitializer] Registered executor instance: ${name}`);
      }
    }

    // Get all registered task types
    const taskTypes = taskManager.getAllTaskTypes();
    logger.info(`✅ [TaskInitializer] Initialized with ${taskTypes.length} task type(s): ${taskTypes.map(t => t.name).join(', ')}`);
  }

  /**
   * Load task executors from a directory
   * Similar to PluginManager.loadPluginsFromDirectory
   *
   * @param directory - Directory path containing task executor files
   */
  static async loadTasksFromDirectory(directory: string): Promise<void> {
    const files = readdirSync(directory);
    const executorFiles = files.filter((file) => extname(file) === '.ts' || extname(file) === '.js');

    if (executorFiles.length > 0) {
      logger.info(`📁 [TaskInitializer] Found ${executorFiles.length} task executor file(s) in directory: ${directory}`);
    }

    for (const file of executorFiles) {
      try {
        const executorPath = join(directory, file);
        const executorModule = await import(executorPath);

        // Support both default export and named export
        const ExecutorClass = executorModule.default || executorModule[Object.keys(executorModule)[0]];

        if (!ExecutorClass) {
          logger.warn(`[TaskInitializer] No executor class found in ${file}`);
          continue;
        }

        // Get task metadata from decorator (decorator executed during import)
        const metadata = getAllTaskMetadata().find(m => m.executorClass === ExecutorClass);
        if (metadata) {
          logger.debug(`[TaskInitializer] Loaded task executor: ${metadata.name} from ${file}`);
        }
      } catch (error) {
        logger.error(`[TaskInitializer] Failed to load task executor from ${file}:`, error);
      }
    }
  }
}
