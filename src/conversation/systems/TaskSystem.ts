// Task System - handles task execution and drives AI capabilities

import type { AIService } from '@/ai/AIService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { System } from '@/core/system';
import { SystemStage } from '@/core/system';
import type { HookManager } from '@/plugins/HookManager';
import { getExtensionHookPriority } from '@/plugins/hooks/HookPriority';
import type { HookContext } from '@/plugins/hooks/types';
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
  // No dependencies, runs independently

  constructor(
    private taskManager: TaskManager,
    private hookManager: HookManager,
  ) {}

  async execute(context: HookContext): Promise<boolean> {
    // Skip if command was already processed
    if (context.command) {
      return true;
    }

    // Skip if reply already exists (may be set by other systems)
    if (context.metadata.get('reply')) {
      return true;
    }

    // Detect task in hookContext
    let task = context.task;

    // If no task exists, try to generate one using AIService
    if (!task) {
      const aiService = this.getAIService();
      if (aiService) {
        logger.debug(
          '[TaskSystem] No task found, attempting to analyze with AI...',
        );
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
      logger.debug(
        '[TaskSystem] No task generated, creating default AI reply task',
      );
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
          logger.debug('[TaskSystem] Generating AI reply for reply task...');
          const aiReply = await aiService.generateReply(context);
          task.reply = aiReply;
          context.aiResponse = aiReply;
        } catch (error) {
          logger.error('[TaskSystem] Failed to generate AI reply:', error);
          task.reply =
            'I apologize, but I encountered an error processing your message.';
        }
      } else {
        // Fallback if AIService is not available
        task.reply = 'I apologize, but AI capabilities are not available.';
      }
    }

    // Hook: onTaskBeforeExecute
    const shouldExecute = await this.hookManager.execute(
      'onTaskBeforeExecute',
      context,
    );
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
        conversationId: context.metadata.get('conversationId') as string,
        messageId: context.message.messageId?.toString(),
      },
      this.hookManager,
      context,
    );

    // Update hook context
    context.result = taskResult;

    // Hook: onTaskExecuted
    await this.hookManager.execute('onTaskExecuted', context);

    // Set reply in metadata
    if (taskResult.reply) {
      context.metadata.set('reply', taskResult.reply);
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

  getExtensionHooks() {
    return [
      {
        hookName: 'onTaskAnalyzed',
        handler: () => true,
        priority: getExtensionHookPriority('onTaskAnalyzed', 'DEFAULT'),
      },
      {
        hookName: 'onTaskBeforeExecute',
        handler: () => true,
        priority: getExtensionHookPriority('onTaskBeforeExecute', 'DEFAULT'),
      },
      {
        hookName: 'onTaskExecuted',
        handler: () => true,
        priority: getExtensionHookPriority('onTaskExecuted', 'DEFAULT'),
      },
      // AI-related hooks are part of task execution
      // These hooks are triggered when AIService is called during task execution
      {
        hookName: 'onMessageBeforeAI',
        handler: () => true,
        priority: getExtensionHookPriority('onMessageBeforeAI', 'DEFAULT'),
      },
      {
        hookName: 'onAIGenerationStart',
        handler: () => true,
        priority: getExtensionHookPriority('onAIGenerationStart', 'DEFAULT'),
      },
      {
        hookName: 'onAIGenerationComplete',
        handler: () => true,
        priority: getExtensionHookPriority('onAIGenerationComplete', 'DEFAULT'),
      },
    ];
  }
}
