// Task System - handles task execution and drives AI capabilities

import type { AIService } from '@/ai/AIService';
import { extractImagesFromSegments } from '@/ai/utils/imageUtils';
import { getReply, getReplyContent, hasReply, setReply } from '@/context/HookContextHelpers';
import { TaskExecutionContextBuilder } from '@/context/TaskExecutionContextBuilder';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/hooks/HookManager';
import { getHookPriority } from '@/hooks/HookPriority';
import type { HookContext } from '@/hooks/types';
import type { TaskManager } from '@/task/TaskManager';
import { logger } from '@/utils/logger';

/**
 * Task System
 * Handles task execution and drives AI capabilities.
 * - If no task exists, tries to analyze and generate task using AIService
 * - If task is "reply" type, uses AIService to generate reply
 * - Executes tasks through TaskManager
 */
export class TaskSystem implements System {
  readonly name = 'task';
  readonly version = '1.0.0';
  readonly stage = SystemStage.PROCESS;
  readonly priority = 20; // Lower priority, but drives AI capabilities

  constructor(
    private taskManager: TaskManager,
    private hookManager: HookManager,
  ) { }

  enabled(): boolean {
    return true;
  }

  async execute(context: HookContext): Promise<boolean> {
    const messageId = context.message?.id || context.message?.messageId || 'unknown';

    // Skip if command was already processed
    if (context.command) {
      return true;
    }

    // Skip if reply already exists (may be set by other systems)
    if (hasReply(context)) {
      const existingReply = getReply(context);
      logger.info(
        `[TaskSystem] Reply already exists, skipping task generation | messageId=${messageId} | replyLength=${existingReply?.length || 0}`,
      );
      return true;
    }

    // Check if this is post-processing only (collect message, no reply)
    const postProcessOnly = context.metadata.get('postProcessOnly');
    if (postProcessOnly) {
      logger.info(
        `[TaskSystem] ✗ Message is marked as post-process only, SKIPPING task generation and reply | messageId=${messageId}`,
      );
      // Still collect the message content (context building happens elsewhere)
      return true;
    }

    logger.info(
      `[TaskSystem] ✓ Message is not post-process only, proceeding with task generation | messageId=${messageId}`,
    );

    // Detect task in hookContext
    let task = context.task;

    // If no task exists, try to generate one using AIService
    if (!task) {
      const aiService = this.getAIService();
      if (aiService) {
        logger.debug('[TaskSystem] No task found, attempting to analyze with AI...');
        const generatedTask = await aiService.analyzeTask(context);
        if (generatedTask) {
          task = generatedTask;
          logger.debug(`[TaskSystem] Generated task: ${generatedTask.type}`);
          context.task = generatedTask;
        }
      }
    }

    // If still no task, create a default "ai reply" task
    if (!task) {
      logger.debug('[TaskSystem] No task generated, creating default AI reply task');
      task = {
        type: 'reply',
        parameters: {},
        executor: 'reply',
      };
      context.task = task;
    }

    // Hook: onTaskAnalyzed (task is ready for execution)
    // This hook is triggered when a task is detected and ready to be executed
    await this.hookManager.execute('onTaskAnalyzed', context);

    // If task is "reply" type and doesn't have a reply, generate one using AIService
    if (task.type === 'reply' && !task.reply) {
      const aiService = this.getAIService();
      if (aiService) {
        try {
          logger.info('[TaskSystem] Generating AI reply for reply task...');

          // Check if message contains images (multimodal support)
          const messageSegments = context.message.segments;
          const hasImages = messageSegments?.some((seg) => seg.type === 'image');

          if (hasImages) {
            // Use vision capability for multimodal input
            const images = extractImagesFromSegments(messageSegments as any[]);
            logger.info(`[TaskSystem] Message contains ${images.length} image(s), using vision capability`);
            await aiService.generateReplyWithVision(context, images);
          } else {
            // Use standard LLM capability
            await aiService.generateReply(context);
          }

          // Get reply from context (set by AIService)
          const replyContent = getReplyContent(context);
          if (replyContent?.segments && replyContent.segments.length > 0) {
            const replyText = getReply(context) || '';
            task.reply = replyText;
            context.aiResponse = replyText;
            logger.info(`[TaskSystem] AI reply generated successfully | replyLength=${replyText.length}`);
          } else {
            logger.warn('[TaskSystem] No reply found in context after AI generation');
            task.reply = 'I apologize, but I encountered an error processing your message.';
          }
        } catch (error) {
          logger.error('[TaskSystem] Failed to generate AI reply:', error);
          task.reply = 'I apologize, but I encountered an error processing your message.';
        }
      } else {
        // Fallback if AIService is not available
        logger.warn('[TaskSystem] AIService is not available. Please configure AI in config file (config.ai).');
        task.reply = 'I apologize, but AI capabilities are not available.';
      }
    }

    // Execute task (TaskManager will handle onTaskBeforeExecute and onTaskExecuted hooks internally)
    const taskExecutionContext = TaskExecutionContextBuilder.fromHookContext(context).build();
    const taskResult = await this.taskManager.execute(task, taskExecutionContext, this.hookManager, context);

    // Update hook context
    context.result = taskResult;

    // Set reply using helper function (similar to CommandSystem pattern)
    if (taskResult.success && taskResult.reply) {
      setReply(context, taskResult.reply, 'task');
    }

    return true;
  }

  /**
   * Get AIService instance from DI container
   */
  private getAIService(): AIService | null {
    try {
      const container = getContainer();
      if (container.isRegistered(DITokens.AI_SERVICE)) {
        return container.resolve<AIService>(DITokens.AI_SERVICE);
      }
    } catch (error) {
      logger.debug('[TaskSystem] AIService not available:', error);
    }
    return null;
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
