// Task System - handles task execution and drives AI capabilities

import type { AIService } from '@/ai/AIService';
import { getReplyMessageIdFromMessage } from '@/ai/utils/imageUtils';
import { hasReply } from '@/context/HookContextHelpers';
import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { System } from '@/core/system';
import { SystemPriority, SystemStage } from '@/core/system';
import type { DatabaseManager } from '@/database/DatabaseManager';
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
  readonly priority = SystemPriority.Task; // Lower priority, but drives AI capabilities

  constructor(
    private taskManager: TaskManager,
    private hookManager: HookManager,
    private aiService: AIService,
    private messageAPI?: MessageAPI,
    private databaseManager?: DatabaseManager,
  ) {}

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    if (this.shouldSkipExecution(context)) {
      return true;
    }

    const tasks = await this.resolveTasks(context);
    this.injectExplainImageFromCurrentMessage(tasks, context);
    await this.injectImageSegmentsFromReplyIntoExplainImageTasks(tasks, context);

    if (tasks.length === 0) {
      await this.executeReplyTask(context);
      return true;
    }

    const taskResults = await this.executeAllTasks(tasks, context);
    await this.aiService.generateReplyFromTaskResults(context, taskResults);
    return true;
  }

  /** Skip when command handled, reply already set, or postProcessOnly. */
  private shouldSkipExecution(context: HookContext): boolean {
    if (context.command) {
      return true;
    }
    if (hasReply(context)) {
      return true;
    }
    if (context.metadata.get('postProcessOnly')) {
      return true;
    }
    return false;
  }

  /** Run keyword detection and LLM analysis; returns task list (may be empty). */
  private async resolveTasks(context: HookContext): Promise<Task[]> {
    const taskTypes = this.taskManager.getAllTaskTypes();
    const triggeredTaskTypes = this.detectTriggeredTaskTypes(context.message.message, taskTypes);
    if (triggeredTaskTypes.length === 0) {
      return [];
    }
    const analysisResult = await this.aiService.analyzeTask(context);
    if (analysisResult.length > 0) {
      logger.info(`[TaskSystem] LLM generated ${analysisResult.length} additional task(s)`);
    }
    return analysisResult;
  }

  /**
   * If the current message has image segments and no explainImage task exists, add one
   * so the executor receives image segments via parameters (avoids context propagation issues).
   */
  private injectExplainImageFromCurrentMessage(tasks: Task[], context: HookContext): void {
    const hasImageSegments = context.message.segments?.some((seg) => seg.type === 'image') ?? false;
    if (!hasImageSegments || tasks.some((t) => t.type === 'explainImage')) {
      return;
    }
    const explainImageType = this.taskManager.getTaskType('explainImage');
    if (!explainImageType || !context.message.segments) {
      return;
    }
    const imageSegments = context.message.segments.filter((seg) => seg.type === 'image');
    tasks.push({
      type: 'explainImage',
      parameters: { imageSegments },
      executor: 'explainImage',
    });
    logger.info('[TaskSystem] Auto-injected explainImage task (message contains image segments)');
  }

  /**
   * For explainImage tasks without imageSegments (e.g. user replied to an image message),
   * try to inject image segments from the referenced reply message (cache may have full segments).
   */
  private async injectImageSegmentsFromReplyIntoExplainImageTasks(
    tasks: Task[],
    context: HookContext,
  ): Promise<void> {
    if (!this.messageAPI || !this.databaseManager) {
      return;
    }
    const replyMessageId = getReplyMessageIdFromMessage(context.message);
    if (replyMessageId === null) {
      return;
    }
    const explainImageTasksWithoutSegments = tasks.filter(
      (t) =>
        t.type === 'explainImage' &&
        (!t.parameters?.imageSegments || (t.parameters.imageSegments as unknown[]).length === 0),
    );
    if (explainImageTasksWithoutSegments.length === 0) {
      return;
    }
    let referencedMessage: Awaited<ReturnType<MessageAPI['getMessageFromContext']>> | null = null;
    try {
      referencedMessage = await this.messageAPI.getMessageFromContext(
        replyMessageId,
        context.message,
        this.databaseManager,
      );
    } catch (err) {
      logger.debug(
        `[TaskSystem] Could not get referenced message for explainImage | messageSeq=${replyMessageId} | error=${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const refImageSegments =
      referencedMessage.segments?.filter((seg: { type: string }) => seg.type === 'image') ?? [];
    if (refImageSegments.length === 0) {
      return;
    }
    for (const task of explainImageTasksWithoutSegments) {
      task.parameters = { ...task.parameters, imageSegments: refImageSegments };
    }
    logger.info(
      `[TaskSystem] Injected ${refImageSegments.length} image segment(s) into explainImage from replied message | messageSeq=${replyMessageId}`,
    );
  }

  /** Execute the default reply task when no other tasks were resolved. */
  private async executeReplyTask(context: HookContext): Promise<void> {
    const replyTask: Task = { type: 'reply', parameters: {}, executor: 'reply' };
    await this.executeSingleTask(replyTask, context);
  }

  /**
   * Detect triggered task types by keywords (used to decide if LLM analysis is needed).
   * Excludes the reply task type.
   */
  private detectTriggeredTaskTypes(userMessage: string, taskTypes: TaskType[]): TaskType[] {
    const messageLower = userMessage.toLowerCase();
    return taskTypes.filter((taskType) => {
      if (taskType.name.toLowerCase() === 'reply') {
        return false;
      }
      const keywords = taskType.triggerKeywords;
      return Array.isArray(keywords) && keywords.length > 0 && keywords.some((k) => messageLower.includes(k.toLowerCase()));
    });
  }

  /**
   * Execute all tasks concurrently and collect results.
   * Each task receives an empty taskResults Map (they cannot see each other's results).
   */
  private async executeAllTasks(tasks: Task[], context: HookContext): Promise<Map<string, TaskResult>> {
    const taskResultPairs = await this.runTasksConcurrently(tasks, context);
    const resultsByType = this.groupResultsByTaskType(taskResultPairs);
    return this.mergeResultsByType(resultsByType);
  }

  /** Run all tasks concurrently; returns array of { taskType, result, index }. */
  private async runTasksConcurrently(
    tasks: Task[],
    context: HookContext,
  ): Promise<Array<{ taskType: string; result: TaskResult; index: number }>> {
    const promises = tasks.map(async (task, index) => {
      try {
        const result = await this.executeSingleTask(task, context);
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
    return Promise.all(promises);
  }

  /** Group result pairs by task type. */
  private groupResultsByTaskType(
    pairs: Array<{ taskType: string; result: TaskResult; index: number }>,
  ): Map<string, TaskResult[]> {
    const resultsByType = new Map<string, TaskResult[]>();
    for (const { taskType, result } of pairs) {
      const list = resultsByType.get(taskType);
      if (list) {
        list.push(result);
      } else {
        resultsByType.set(taskType, [result]);
      }
    }
    return resultsByType;
  }

  /** Merge multiple results per type into a single result per type. */
  private mergeResultsByType(resultsByType: Map<string, TaskResult[]>): Map<string, TaskResult> {
    const results = new Map<string, TaskResult>();
    for (const [taskType, typeResults] of resultsByType.entries()) {
      if (typeResults.length === 1) {
        results.set(taskType, typeResults[0]);
      } else {
        results.set(taskType, this.mergeTaskResults(taskType, typeResults));
        logger.info(`[TaskSystem] Merged ${typeResults.length} results for task type '${taskType}'`);
      }
    }
    return results;
  }

  /** Merge multiple task results of the same type into one (for duplicate task types). */
  private mergeTaskResults(taskType: string, results: TaskResult[]): TaskResult {
    const overallSuccess = results.some((r) => r.success);
    const errors = this.collectUniqueErrors(results);
    const mergedReply = this.mergeReplyStrings(taskType, results);
    const mergedData = this.mergeResultDataObjects(results);
    return {
      success: overallSuccess,
      reply: mergedReply,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      data: Object.keys(mergedData).length > 0 ? mergedData : undefined,
    };
  }

  private collectUniqueErrors(results: TaskResult[]): string[] {
    const errors = results.filter((r): r is TaskResult & { error: string } => Boolean(r.error)).map((r) => r.error);
    return [...new Set(errors)];
  }

  private mergeReplyStrings(taskType: string, results: TaskResult[]): string {
    if (taskType === 'search') {
      const searchResults = results
        .filter((r) => r.success && r.reply)
        .map((r) => (r.reply as string).trim())
        .filter((reply) => reply.length > 0);
      return searchResults.length > 0 ? searchResults.join('\n\n---\n\n') : (results[0]?.reply ?? 'No search results found');
    }
    const parts: string[] = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.success && result.reply) {
        parts.push(results.length > 1 ? `[${taskType} ${index + 1}]\n${result.reply.trim()}` : result.reply.trim());
      } else if (result.error) {
        parts.push(`[${taskType} ${index + 1}] Failed: ${result.error}`);
      }
    }
    return parts.join('\n\n');
  }

  private mergeResultDataObjects(results: TaskResult[]): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (!result.data) {
        continue;
      }
      if (results.length > 1) {
        for (const [key, value] of Object.entries(result.data)) {
          merged[`${key}_${index}`] = value;
        }
      } else {
        Object.assign(merged, result.data);
      }
    }
    return merged;
  }

  /**
   * Execute a single task
   * @param task - Task to execute
   * @param context - Hook context
   */
  private async executeSingleTask(task: Task, context: HookContext): Promise<TaskResult> {
    // All tasks execute through TaskManager
    // Pass HookContext as first-class field for type safety
    // Task results are collected after completion and passed directly to reply generation
    const taskExecutionContext = TaskExecutionContextBuilder.fromHookContext(context)
      .withTaskResults(new Map<string, TaskResult>())
      .build();

    return await this.taskManager.execute(task, taskExecutionContext, this.hookManager, context);
  }

  /**
   * Analyze the message in context for task triggers and execute any detected tasks.
   * Returns the task result map without generating a reply.
   *
   * Used by flows that bypass the message lifecycle (e.g. proactive conversation) but
   * still need task analysis and execution through the registered task system.
   * The caller is responsible for incorporating task results into its own reply generation.
   *
   * @param context - HookContext built from a synthetic message representing the text to analyze
   * @returns Map of task type to task result; empty map when no tasks triggered
   */
  /**
   * Analyze the message for task triggers and execute tasks (no reply generation).
   * Used by flows that bypass the message lifecycle (e.g. proactive conversation).
   */
  async analyzeAndExecuteTasks(context: HookContext): Promise<Map<string, TaskResult>> {
    const tasks = await this.resolveTasks(context);
    if (tasks.length === 0) {
      return new Map();
    }
    this.injectExplainImageFromCurrentMessage(tasks, context);
    await this.injectImageSegmentsFromReplyIntoExplainImageTasks(tasks, context);
    logger.info(`[TaskSystem] analyzeAndExecuteTasks: executing ${tasks.length} task(s)`);
    return await this.executeAllTasks(tasks, context);
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
