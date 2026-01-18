// Task System - handles task execution and drives AI capabilities

import type { AIService } from '@/ai/AIService';
import { hasReply } from '@/context/HookContextHelpers';
import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import type { Task, TaskResult, TaskType } from '@/task/types';
import { logger } from '@/utils/logger';

/**
 * Task System
 * Handles task execution and drives AI capabilities.
 * - If no task exists, tries to analyze and generate task using AIService
 * - Executes all tasks (including reply) through TaskManager
 */
export class TaskSystem implements System {
  readonly name = 'task';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PROCESS;
  readonly priority = 20; // Lower priority, but drives AI capabilities

  constructor(
    private taskManager: TaskManager,
    private hookManager: HookManager,
    private aiService: AIService,
  ) { }

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    // 1. Skip checks (keep existing logic)
    if (context.command) {
      return true;
    }

    if (hasReply(context)) {
      return true;
    }
    const postProcessOnly = context.metadata.get('postProcessOnly');
    if (postProcessOnly) {
      return true;
    }

    // 2. Keyword detection: determine if additional tasks are needed
    const taskTypes = this.taskManager.getAllTaskTypes();
    const triggeredTaskTypes = this.detectTriggeredTaskTypes(
      context.message.message,
      taskTypes
    );

    // 3. If there are triggered keywords, call LLM analysis to generate task list
    let additionalTasks: Task[] = [];
    if (triggeredTaskTypes.length > 0) {
      const analysisResult = await this.aiService.analyzeTask(context);
      additionalTasks = analysisResult;  // Already filtered reply, always returns array
      if (additionalTasks.length > 0) {
        logger.info(`[TaskSystem] LLM generated ${additionalTasks.length} additional task(s)`);
      }
    }

    // 4. If no additional tasks, create and execute reply task
    if (additionalTasks.length === 0) {
      const replyTask: Task = {
        type: 'reply',
        parameters: {},
        executor: 'reply',
      };
      // Execute reply task - ReplyTaskExecutor will set context.reply directly
      // ReplyTaskExecutor will use empty Map by default (no other tasks in this path)
      await this.executeSingleTask(replyTask, context);
      return true;
    }

    // 5. Execute all tasks concurrently (including search, no special treatment)
    const taskResults = await this.executeAllTasks(additionalTasks, context);

    // 6. Call unified reply generation method
    // This method handles all cases: with/without images, with/without task results, with/without search
    await this.aiService.generateReplyFromTaskResults(context, taskResults);

    return true;
  }

  /**
   * Detect triggered task types by keywords
   * Used for quick filtering to determine if LLM analysis is needed
   * @param userMessage - User message
   * @param taskTypes - All registered task types
   * @returns Matched task types list (excluding reply)
   */
  private detectTriggeredTaskTypes(
    userMessage: string,
    taskTypes: TaskType[]
  ): TaskType[] {
    const messageLower = userMessage.toLowerCase();
    const triggered: TaskType[] = [];

    for (const taskType of taskTypes) {
      // Skip reply task
      if (taskType.name.toLowerCase() === 'reply') {
        continue;
      }

      // Check if there are trigger keywords
      if (taskType.triggerKeywords && taskType.triggerKeywords.length > 0) {
        const hasKeyword = taskType.triggerKeywords.some(keyword =>
          messageLower.includes(keyword.toLowerCase())
        );

        if (hasKeyword) {
          triggered.push(taskType);
        }
      }
    }

    return triggered;
  }

  /**
   * Execute all tasks concurrently and collect results
   * Note: Do NOT pass taskResults to executeSingleTask here because:
   * 1. Tasks execute concurrently, so they cannot know other tasks' results
   * 2. Each task should receive an empty Map to avoid confusion
   * 3. Task results are collected after all tasks complete, then passed to reply generation
   */
  private async executeAllTasks(
    tasks: Task[],
    context: HookContext
  ): Promise<Map<string, TaskResult>> {
    // Execute all tasks concurrently
    // Do NOT pass taskResults - tasks execute concurrently and cannot access each other's results
    const taskPromises = tasks.map(async (task, index) => {
      try {
        const result = await this.executeSingleTask(task, context); // No taskResults passed
        return { taskType: task.type, result, index };
      } catch (error) {
        logger.error(`[TaskSystem] Task ${task.type} failed:`, error);
        return {
          taskType: task.type,
          result: {
            success: false,
            reply: `Task ${task.type} execution failed`,
            error: error instanceof Error ? error.message : 'Unknown error',
          } as TaskResult,
          index,
        };
      }
    });

    // Wait for all tasks to complete
    const taskResults = await Promise.all(taskPromises);

    // Group results by task type and merge duplicates intelligently
    const resultsByType = new Map<string, TaskResult[]>();

    // Group results by type
    for (const { taskType, result } of taskResults) {
      if (!resultsByType.has(taskType)) {
        resultsByType.set(taskType, []);
      }
      resultsByType.get(taskType)!.push(result);
    }

    // Merge results for each type
    const results = new Map<string, TaskResult>();
    for (const [taskType, typeResults] of resultsByType.entries()) {
      if (typeResults.length === 1) {
        // Single result - use directly
        results.set(taskType, typeResults[0]);
      } else {
        // Multiple results - merge intelligently
        const merged = this.mergeTaskResults(taskType, typeResults);
        results.set(taskType, merged);
        logger.info(`[TaskSystem] Merged ${typeResults.length} results for task type '${taskType}'`);
      }
    }

    return results;
  }

  /**
   * Merge multiple task results of the same type intelligently
   * @param taskType - Task type name
   * @param results - Array of task results to merge
   * @returns Merged task result
   */
  private mergeTaskResults(taskType: string, results: TaskResult[]): TaskResult {
    // Determine overall success: if any succeeded, overall is successful
    const overallSuccess = results.some(r => r.success);

    // Collect all errors
    const errors = results
      .filter(r => r.error)
      .map(r => r.error!)
      .filter((error, index, self) => self.indexOf(error) === index); // Remove duplicates

    // Merge reply messages based on task type
    let mergedReply: string;
    if (taskType === 'search') {
      // For search: combine all search results with clear separation
      const searchResults = results
        .filter(r => r.success && r.reply)
        .map(r => r.reply.trim())
        .filter(reply => reply.length > 0);

      if (searchResults.length > 0) {
        mergedReply = searchResults.join('\n\n---\n\n');
      } else {
        mergedReply = results[0].reply || 'No search results found';
      }
    } else {
      // For other tasks: combine with numbered sections
      const replyParts: string[] = [];
      results.forEach((result, index) => {
        if (result.success && result.reply) {
          if (results.length > 1) {
            replyParts.push(`[${taskType} ${index + 1}]\n${result.reply.trim()}`);
          } else {
            replyParts.push(result.reply.trim());
          }
        } else if (result.error) {
          replyParts.push(`[${taskType} ${index + 1}] Failed: ${result.error}`);
        }
      });
      mergedReply = replyParts.join('\n\n');
    }

    // Merge data objects
    const mergedData: Record<string, unknown> = {};
    results.forEach((result, index) => {
      if (result.data) {
        // Prefix keys with index if multiple results to avoid conflicts
        if (results.length > 1) {
          for (const [key, value] of Object.entries(result.data)) {
            mergedData[`${key}_${index}`] = value;
          }
        } else {
          Object.assign(mergedData, result.data);
        }
      }
    });

    return {
      success: overallSuccess,
      reply: mergedReply,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      data: Object.keys(mergedData).length > 0 ? mergedData : undefined,
    };
  }

  /**
   * Execute a single task
   * @param task - Task to execute
   * @param context - Hook context
   */
  private async executeSingleTask(
    task: Task,
    context: HookContext
  ): Promise<TaskResult> {
    // All tasks execute through TaskManager
    // Pass HookContext as first-class field for type safety
    // Task results are collected after completion and passed directly to reply generation
    const taskExecutionContext = TaskExecutionContextBuilder
      .fromHookContext(context)
      .withTaskResults(new Map<string, TaskResult>())
      .build();

    return await this.taskManager.execute(
      task,
      taskExecutionContext,
      this.hookManager,
      context
    );
  }


  /**
   * Declare extension hooks that plugins can subscribe to
   * These hooks are declared without handlers - plugins can register their own handlers
   * The priority is used as default when plugins register handlers without specifying priority
   */
  getExtensionHooks() {
    return [
      {
        hookName: 'onTaskAnalyzed',
        priority: getHookPriority('onTaskAnalyzed', 'NORMAL'),
      },
      {
        hookName: 'onTaskBeforeExecute',
        priority: getHookPriority('onTaskBeforeExecute', 'NORMAL'),
      },
      {
        hookName: 'onTaskExecuted',
        priority: getHookPriority('onTaskExecuted', 'NORMAL'),
      },
      // AI-related hooks are triggered during task execution when AIService is used
      // These hooks are declared here because TaskSystem drives AI capabilities
      // AIService internally calls these hooks, but TaskSystem declares them for plugin registration
      {
        hookName: 'onMessageBeforeAI',
        priority: getHookPriority('onMessageBeforeAI', 'NORMAL'),
      },
      {
        hookName: 'onAIGenerationStart',
        priority: getHookPriority('onAIGenerationStart', 'NORMAL'),
      },
      {
        hookName: 'onAIGenerationComplete',
        priority: getHookPriority('onAIGenerationComplete', 'NORMAL'),
      },
    ];
  }
}
