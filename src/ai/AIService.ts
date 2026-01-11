// AI Service - provides AI capabilities as a service

import type { ContextManager } from '@/context/ContextManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { TaskAnalyzer } from '@/task/TaskAnalyzer';
import type { Task } from '@/task/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import { PromptManager } from './PromptManager';

/**
 * AI Service
 * Provides AI capabilities as a service to other systems.
 * This is NOT a System - it's a service that can be called by systems.
 *
 * Capabilities:
 * 1. generateReply: Generate AI response for user input
 * 2. analyzeTask: Analyze user input and generate tasks
 *
 * Other systems (like TaskSystem) should inject this service to use AI capabilities.
 */
export class AIService {
  private promptManager: PromptManager;

  constructor(
    private aiManager: AIManager,
    private contextManager: ContextManager,
    private hookManager: HookManager,
    private taskAnalyzer?: TaskAnalyzer, // Optional: only used if TaskAnalyzer is available
    promptManager?: PromptManager, // Optional: can provide custom PromptManager
  ) {
    // Initialize PromptManager
    this.promptManager = promptManager || new PromptManager();
    this.initializeDefaultPrompts();
  }

  /**
   * Initialize default prompt templates
   */
  private initializeDefaultPrompts(): void {
    // Register default reply prompt template
    this.promptManager.registerTemplate({
      name: 'reply',
      content: `You are a helpful QQ bot assistant. Respond to user messages naturally and helpfully.

User message: {{userMessage}}

{{conversationHistory}}

Please provide a helpful response.`,
      variables: ['userMessage', 'conversationHistory'],
    });
  }

  /**
   * Generate AI reply for user message
   * This method can be called by other systems (e.g., TaskSystem) to generate AI replies
   */
  async generateReply(context: HookContext): Promise<string> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute(
      'onMessageBeforeAI',
      context,
    );
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(
        context.message.message,
        {
          sessionId: context.metadata.get('sessionId') as string,
          sessionType: context.metadata.get('sessionType') as 'user' | 'group',
          userId: context.message.userId,
          groupId: context.message.groupId,
        },
      );
      context.context = conversationContext;
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      // Build conversation history for prompt
      const history = context.context?.history || [];
      const historyText =
        history.length > 0
          ? `Conversation history:\n${history
              .map(
                (msg) =>
                  `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`,
              )
              .join('\n')}\n`
          : '';

      // Build prompt using PromptManager
      const prompt = this.promptManager.render('reply', {
        userMessage: context.message.message,
        conversationHistory: historyText,
      });

      // Generate AI response
      const response = await this.aiManager.generate(prompt, {
        temperature: 0.7,
        maxTokens: 2000,
      });

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      return response.text;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AIService] Failed to generate AI reply:', err);
      throw err;
    }
  }

  /**
   * Analyze user input and generate task
   * This method can be called by other systems (e.g., TaskSystem) to analyze and generate tasks
   * Returns null if task analysis is not available or fails
   */
  async analyzeTask(context: HookContext): Promise<Task | null> {
    if (!this.taskAnalyzer) {
      logger.debug(
        '[AIService] TaskAnalyzer not available, cannot analyze task',
      );
      return null;
    }

    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute(
      'onMessageBeforeAI',
      context,
    );
    if (!shouldContinue) {
      return null;
    }

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(
        context.message.message,
        {
          sessionId: context.metadata.get('sessionId') as string,
          sessionType: context.metadata.get('sessionType') as 'user' | 'group',
          userId: context.message.userId,
          groupId: context.message.groupId,
        },
      );
      context.context = conversationContext;
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      logger.debug('[AIService] Analyzing task with AI...');

      // Analyze with AI to generate task
      const analysisResult = await this.taskAnalyzer.analyze({
        userMessage: context.message.message,
        conversationHistory: context.context.history.map((h) => ({
          role: h.role,
          content: h.content,
        })),
        userId: context.message.userId,
        groupId: context.message.groupId,
        messageType: context.message.messageType,
      });

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      return analysisResult.task;
    } catch (error) {
      logger.warn('[AIService] Task analysis failed:', error);
      // Hook: onAIGenerationComplete (even on error)
      await this.hookManager.execute('onAIGenerationComplete', context);
      return null;
    }
  }
}
