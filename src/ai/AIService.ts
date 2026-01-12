// AI Service - provides AI capabilities as a service

import type { ContextManager } from '@/context/ContextManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { TaskAnalyzer } from '@/task/TaskAnalyzer';
import type { Task } from '@/task/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { ImageGenerationResponse, Text2ImageOptions, VisionImage } from './capabilities/types';
import { PromptManager } from './PromptManager';
import type { ProviderSelector } from './ProviderSelector';
import { ImageGenerationService } from './services/ImageGenerationService';
import { LLMService } from './services/LLMService';
import { VisionService } from './services/VisionService';

/**
 * AI Service
 * Provides AI capabilities as a service to other systems.
 * This is NOT a System - it's a service that can be called by systems.
 *
 * Capabilities:
 * 1. generateReply: Generate AI response for user input
 * 2. analyzeTask: Analyze user input and generate tasks
 * 3. Vision support: Generate responses with images
 * 4. Image generation: Text-to-image and image-to-image
 *
 * Other systems (like TaskSystem) should inject this service to use AI capabilities.
 */
export class AIService {
  private promptManager: PromptManager;
  private maxHistoryMessages: number;
  private llmService: LLMService;
  private visionService: VisionService;
  private imageGenerationService: ImageGenerationService;

  constructor(
    aiManager: AIManager,
    private contextManager: ContextManager,
    private hookManager: HookManager,
    promptManager: PromptManager, // Required: must be provided from DI container
    private taskAnalyzer?: TaskAnalyzer, // Optional: only used if TaskAnalyzer is available
    maxHistoryMessages = 10, // Maximum number of history messages to include in prompt
    providerSelector?: ProviderSelector, // Optional: for session-level provider selection
  ) {
    // Initialize PromptManager
    this.promptManager = promptManager;
    this.maxHistoryMessages = maxHistoryMessages;

    // Initialize business services
    this.llmService = new LLMService(aiManager, providerSelector);
    this.visionService = new VisionService(aiManager, providerSelector);
    this.imageGenerationService = new ImageGenerationService(aiManager, providerSelector);
  }

  /**
   * Analyze user input and generate task
   * This method can be called by other systems (e.g., TaskSystem) to analyze and generate tasks
   * Returns null if task analysis is not available or fails
   */
  async analyzeTask(context: HookContext): Promise<Task | null> {
    if (!this.taskAnalyzer) {
      logger.debug('[AIService] TaskAnalyzer not available, cannot analyze task');
      return null;
    }

    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      return null;
    }

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(context.message.message, {
        sessionId: context.metadata.get('sessionId') as string,
        sessionType: context.metadata.get('sessionType') as 'user' | 'group',
        userId: context.message.userId,
        groupId: context.message.groupId,
      });
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

  /**
   * Generate AI reply for user message
   * This method can be called by other systems (e.g., TaskSystem) to generate AI replies
   */
  async generateReply(context: HookContext): Promise<string> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(context.message.message, {
        sessionId: context.metadata.get('sessionId') as string,
        sessionType: context.metadata.get('sessionType') as 'user' | 'group',
        userId: context.message.userId,
        groupId: context.message.groupId,
      });
      context.context = conversationContext;
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      // Build conversation history for prompt
      // Limit to configured number of messages to prevent prompt from being too long
      const history = context.context?.history || [];
      const limitedHistory = history.slice(-this.maxHistoryMessages);

      const historyText =
        limitedHistory.length > 0
          ? `Conversation history:\n${limitedHistory
              .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
              .join('\n')}\n`
          : '';

      // Build prompt using PromptManager
      // Template name: 'llm.reply' (from prompts/llm/reply.txt)
      const prompt = this.promptManager.render('llm.reply', {
        userMessage: context.message.message,
        conversationHistory: historyText,
      });

      // Get session ID for provider selection and context loading
      const sessionId = context.metadata.get('sessionId') as string | undefined;

      // Generate AI response using LLM service
      const response = await this.llmService.generate(prompt, {
        temperature: 0.7,
        maxTokens: 2000,
        sessionId,
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
   * Generate reply with vision support (multimodal)
   * Detects images in message and uses vision capability if available
   */
  async generateReplyWithVision(context: HookContext, images?: VisionImage[]): Promise<string> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(context.message.message, {
        sessionId: context.metadata.get('sessionId') as string,
        sessionType: context.metadata.get('sessionType') as 'user' | 'group',
        userId: context.message.userId,
        groupId: context.message.groupId,
      });
      context.context = conversationContext;
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const sessionId = context.metadata.get('sessionId') as string | undefined;
      const history = context.context?.history || [];
      const limitedHistory = history.slice(-this.maxHistoryMessages);

      const historyText =
        limitedHistory.length > 0
          ? `Conversation history:\n${limitedHistory
              .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
              .join('\n')}\n`
          : '';

      // Build prompt
      // Template name: 'llm.reply' (from prompts/llm/reply.txt)
      const prompt = this.promptManager.render('llm.reply', {
        userMessage: context.message.message,
        conversationHistory: historyText,
      });

      let response;

      // Use vision if images are provided
      // sessionId is passed in options for both provider selection and context loading
      if (images && images.length > 0) {
        response = await this.visionService.generateWithVision(prompt, images, {
          temperature: 0.7,
          maxTokens: 2000,
          sessionId,
        });
      } else {
        // Use LLM
        // sessionId is passed in options for both provider selection and context loading
        response = await this.llmService.generate(prompt, {
          temperature: 0.7,
          maxTokens: 2000,
          sessionId,
        });
      }

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      return response.text;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AIService] Failed to generate AI reply with vision:', err);
      throw err;
    }
  }

  /**
   * Generate image from text prompt
   * This method can be called by other systems to generate images from text descriptions
   */
  async generateImg(context: HookContext, options?: Text2ImageOptions): Promise<ImageGenerationResponse> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('Image generation interrupted by hook');
    }

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(context.message.message, {
        sessionId: context.metadata.get('sessionId') as string,
        sessionType: context.metadata.get('sessionType') as 'user' | 'group',
        userId: context.message.userId,
        groupId: context.message.groupId,
      });
      context.context = conversationContext;
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      // Get session ID for provider selection
      const sessionId = context.metadata.get('sessionId') as string | undefined;

      // Build prompt using PromptManager
      // Template name: 'text2img.generate' (from prompts/text2img/generate.txt)
      const prompt = this.promptManager.render('text2img.generate', {
        description: context.message.message,
        style: options?.style || 'default',
        quality: options?.quality || 'standard',
      });

      logger.debug('[AIService] Generating image with prompt:', prompt);

      // Generate image using ImageGenerationService
      const response = await this.imageGenerationService.generateImage(prompt, options, sessionId);

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AIService] Failed to generate image:', err);
      // Hook: onAIGenerationComplete (even on error)
      await this.hookManager.execute('onAIGenerationComplete', context);
      throw err;
    }
  }
}
