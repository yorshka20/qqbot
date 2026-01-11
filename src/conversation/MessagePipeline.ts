// Message Pipeline - processes messages through the complete flow

import type { NormalizedMessageEvent } from '@/events/types';
import type { CommandManager } from '@/command/CommandManager';
import type { ParsedCommand } from '@/command/types';
import type { TaskManager } from '@/task/TaskManager';
import type { TaskAnalyzer } from '@/task/TaskAnalyzer';
import type { ContextManager } from '@/context/ContextManager';
import type { AIManager } from '@/ai/AIManager';
import type { HookManager } from '@/plugins/HookManager';
import type { APIClient } from '@/api/APIClient';
import type { CommandRouter } from './CommandRouter';
import type { MessageProcessingResult, MessageProcessingContext } from './types';
import type { HookContext } from '@/plugins/hooks/types';
import { logger } from '@/utils/logger';

/**
 * Message Pipeline
 * Processes messages through the complete flow with hooks
 */
export class MessagePipeline {
  constructor(
    private commandRouter: CommandRouter,
    private commandManager: CommandManager,
    private taskManager: TaskManager,
    private taskAnalyzer: TaskAnalyzer,
    private contextManager: ContextManager,
    private aiManager: AIManager,
    private hookManager: HookManager,
    private apiClient: APIClient,
  ) {}

  /**
   * Process message through the complete pipeline
   */
  async process(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
  ): Promise<MessageProcessingResult> {
    try {
      // Create initial hook context
      const hookContext: HookContext = {
        message: event,
        metadata: new Map(),
      };

      // Hook: onMessageReceived
      const shouldContinue = await this.hookManager.execute(
        'onMessageReceived',
        hookContext,
      );
      if (!shouldContinue) {
        return { success: false, error: 'Processing interrupted by hook' };
      }

      // Parse command
      const command = this.commandRouter.route(event.message);

      // Hook: onMessagePreprocess
      await this.hookManager.execute('onMessagePreprocess', hookContext);

      // Route: Command or AI processing
      if (command) {
        return await this.processCommand(command, event, context, hookContext);
      } else {
        return await this.processAI(event, context, hookContext);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MessagePipeline] Error processing message:', err);

      // Hook: onError
      const errorContext: HookContext = {
        message: event,
        error: err,
        metadata: new Map(),
      };
      await this.hookManager.execute('onError', errorContext);

      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Process command message
   */
  private async processCommand(
    command: ParsedCommand,
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
    hookContext: HookContext,
  ): Promise<MessageProcessingResult> {
    // Update hook context
    hookContext.command = command;

    // Hook: onCommandDetected
    const shouldContinue = await this.hookManager.execute(
      'onCommandDetected',
      hookContext,
    );
    if (!shouldContinue) {
      return { success: false, error: 'Command execution interrupted by hook' };
    }

    // Execute command
    const commandResult = await this.commandManager.execute(command, {
      userId: event.userId,
      groupId: event.groupId,
      messageType: event.messageType,
      rawMessage: event.message,
    });

    // Update hook context
    hookContext.result = commandResult;

    // Hook: onCommandExecuted
    await this.hookManager.execute('onCommandExecuted', hookContext);

    // Send reply if available
    if (commandResult.success && commandResult.message) {
      await this.sendMessage(
        event,
        commandResult.message,
        hookContext,
      );
    }

    return {
      success: commandResult.success,
      reply: commandResult.message,
      error: commandResult.error,
    };
  }

  /**
   * Process AI message
   */
  private async processAI(
    event: NormalizedMessageEvent,
    context: MessageProcessingContext,
    hookContext: HookContext,
  ): Promise<MessageProcessingResult> {
    // Build context
    const conversationContext = this.contextManager.buildContext(event.message, {
      sessionId: context.sessionId,
      sessionType: context.sessionType,
      userId: event.userId,
      groupId: event.groupId,
      systemPrompt: undefined, // Can be configured
    });

    // Update hook context
    hookContext.context = conversationContext;

    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute(
      'onMessageBeforeAI',
      hookContext,
    );
    if (!shouldContinue) {
      return { success: false, error: 'AI processing interrupted by hook' };
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', hookContext);

    // Analyze with AI to generate task
    const analysisResult = await this.taskAnalyzer.analyze({
      userMessage: event.message,
      conversationHistory: conversationContext.history.map((h) => ({
        role: h.role,
        content: h.content,
      })),
      userId: event.userId,
      groupId: event.groupId,
      messageType: event.messageType,
    });

    // Update hook context
    hookContext.task = analysisResult.task;
    hookContext.aiResponse = analysisResult.task.reply;

    // Hook: onAIGenerationComplete
    await this.hookManager.execute('onAIGenerationComplete', hookContext);

    // Hook: onTaskAnalyzed
    await this.hookManager.execute('onTaskAnalyzed', hookContext);

    // Hook: onTaskBeforeExecute
    const shouldExecute = await this.hookManager.execute(
      'onTaskBeforeExecute',
      hookContext,
    );
    if (!shouldExecute) {
      return { success: false, error: 'Task execution interrupted by hook' };
    }

    // Execute task
    const taskResult = await this.taskManager.execute(analysisResult.task, {
      userId: event.userId,
      groupId: event.groupId,
      messageType: event.messageType,
      conversationId: context.conversationId,
      messageId: event.messageId?.toString(),
    });

    // Update hook context
    hookContext.result = taskResult;

    // Hook: onTaskExecuted
    await this.hookManager.execute('onTaskExecuted', hookContext);

    // Add message to conversation history
    await this.contextManager.addMessage(context.sessionId, 'user', event.message);
    if (taskResult.reply) {
      await this.contextManager.addMessage(
        context.sessionId,
        'assistant',
        taskResult.reply,
      );
    }

    // Send reply
    if (taskResult.reply) {
      await this.sendMessage(event, taskResult.reply, hookContext);
    }

    return {
      success: taskResult.success,
      reply: taskResult.reply,
      error: taskResult.error,
    };
  }

  /**
   * Send message
   */
  private async sendMessage(
    event: NormalizedMessageEvent,
    reply: string,
    hookContext: HookContext,
  ): Promise<void> {
    // Update hook context
    hookContext.metadata.set('reply', reply);

    // Hook: onMessageBeforeSend
    const shouldContinue = await this.hookManager.execute(
      'onMessageBeforeSend',
      hookContext,
    );
    if (!shouldContinue) {
      logger.warn('[MessagePipeline] Message sending interrupted by hook');
      return;
    }

    // Get final reply (may be modified by hook)
    const finalReply = hookContext.metadata.get('reply') as string || reply;

    try {
      // Send message via API
      if (event.messageType === 'private') {
        await this.apiClient.call('send_private_msg', {
          user_id: event.userId,
          message: finalReply,
        }, 'milky'); // Use configured protocol
      } else if (event.groupId) {
        await this.apiClient.call('send_group_msg', {
          group_id: event.groupId,
          message: finalReply,
        }, 'milky'); // Use configured protocol
      }

      // Hook: onMessageSent
      await this.hookManager.execute('onMessageSent', hookContext);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[MessagePipeline] Failed to send message:', err);

      // Hook: onError
      const errorContext: HookContext = {
        ...hookContext,
        error: err,
      };
      await this.hookManager.execute('onError', errorContext);
    }
  }
}
