// Task System - handles task execution and drives AI capabilities

import type { AIService } from '@/ai/AIService';
import { extractImagesFromSegments } from '@/ai/utils/imageUtils';
import { getReply, hasReply, setReply } from '@/context/HookContextHelpers';
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
  ) {}

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

          let aiReply: string;

          if (hasImages) {
            // Use vision capability for multimodal input
            const images = extractImagesFromSegments(messageSegments as any[]);
            logger.info(`[TaskSystem] Message contains ${images.length} image(s), using vision capability`);
            aiReply = await aiService.generateReplyWithVision(context, images);
          } else {
            // Use standard LLM capability
            aiReply = await aiService.generateReply(context);
          }

          task.reply = aiReply;
          context.aiResponse = aiReply;
          logger.info(`[TaskSystem] AI reply generated successfully | replyLength=${aiReply.length}`);
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

    // Hook: onTaskBeforeExecute
    const shouldExecute = await this.hookManager.execute('onTaskBeforeExecute', context);
    if (!shouldExecute) {
      return false;
    }

    // Execute task
    const taskResult = await this.taskManager.execute(
      task,
      {
        userId: context.message.userId,
        groupId: context.message.groupId,
        messageType: context.message.messageType,
        conversationId: context.metadata.get('conversationId'),
        messageId: context.message.messageId?.toString(),
      },
      this.hookManager,
      context,
    );

    // Update hook context
    context.result = taskResult;

    // Hook: onTaskExecuted
    await this.hookManager.execute('onTaskExecuted', context);

    // Set reply using helper function
    if (taskResult.reply) {
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
      // AI-related hooks are part of task execution
      // These hooks are triggered when AIService is called during task execution
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
