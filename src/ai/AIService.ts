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
  private llmService: LLMService;
  private visionService: VisionService;
  private imageGenerationService: ImageGenerationService;

  constructor(
    aiManager: AIManager,
    private contextManager: ContextManager,
    private hookManager: HookManager,
    private promptManager: PromptManager, // Required: must be provided from DI container
    private taskAnalyzer?: TaskAnalyzer, // Optional: only used if TaskAnalyzer is available
    private maxHistoryMessages = 10, // Maximum number of history messages to include in prompt
    providerSelector?: ProviderSelector, // Optional: for session-level provider selection
  ) {
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
      const historyText = this.buildConversationHistory(context);

      // Build prompt
      // Template name: 'llm.reply' (from prompts/llm/reply.txt)
      const prompt = this.promptManager.render('llm.reply', {
        userMessage: context.message.message,
        conversationHistory: historyText,
      });

      let response;

      // Use vision if images are provided
      if (images && images.length > 0) {
        response = await this.visionService.generateWithVision(prompt, images, {
          temperature: 0.7,
          maxTokens: 2000,
          sessionId,
        });
      } else {
        // Use LLM
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
   * Now includes LLM preprocessing to convert user input to standardized image generation parameters
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

      const userInput = context.message.message;
      logger.debug(`[AIService] Processing image generation request | userInput=${userInput.substring(0, 50)}...`);

      // Step 1: Use LLM to preprocess user input and convert to standardized parameters
      let processedPrompt: string;
      let processedOptions: Text2ImageOptions;

      try {
        // Build LLM prompt using PromptManager
        // Template name: 'text2img.generate' (from prompts/text2img/generate.txt)
        const llmPrompt = this.promptManager.render('text2img.generate', {
          description: userInput,
        });

        logger.debug('[AIService] Calling LLM to preprocess image generation parameters...');

        // Call LLM to generate JSON parameters
        const llmResponse = await this.llmService.generate(llmPrompt, {
          temperature: 0.3, // Lower temperature for more consistent JSON output
          maxTokens: 1000,
          sessionId,
        });

        logger.debug(`[AIService] LLM response received | responseLength=${llmResponse.text.length}`);

        // Step 2: Parse LLM response to extract image generation parameters
        const parsedParams = this.parseImageGenerationParams(llmResponse.text, userInput);

        processedPrompt = parsedParams.prompt;
        processedOptions = {
          steps: parsedParams.steps,
          guidance_scale: parsedParams.cfg_scale,
          seed: parsedParams.seed,
          width: parsedParams.width,
          height: parsedParams.height,
          negative_prompt: parsedParams.negative_prompt,
          // Add sampler as provider-specific option
          sampler: parsedParams.sampler,
          // Merge with user-provided options (user options take precedence)
          ...options,
        };

        logger.info(
          `[AIService] LLM preprocessing completed | original="${userInput.substring(0, 50)}..." | processed="${processedPrompt.substring(0, 50)}..." | steps=${processedOptions.steps} | cfg=${processedOptions.guidance_scale}`,
        );
      } catch (llmError) {
        const llmErr = llmError instanceof Error ? llmError : new Error('Unknown LLM error');
        logger.warn(
          `[AIService] LLM preprocessing failed, falling back to direct user input | error=${llmErr.message}`,
        );

        // Fallback: Use user input directly as prompt
        processedPrompt = userInput;
        processedOptions = {
          steps: 30,
          guidance_scale: 7.5,
          seed: -1,
          width: 1024,
          height: 1024,
          // Merge with user-provided options
          ...options,
        };

        logger.info('[AIService] Using fallback: direct user input as prompt');
      }

      // Step 3: Generate image using ImageGenerationService with processed parameters
      logger.debug(
        `[AIService] Generating image | prompt="${processedPrompt.substring(0, 50)}..." | options=${JSON.stringify(processedOptions)}`,
      );

      const response = await this.imageGenerationService.generateImage(processedPrompt, processedOptions, sessionId);

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

  /**
   * Parse LLM response to extract image generation parameters
   * Handles various response formats including JSON wrapped in markdown code blocks
   * @param llmResponse - Raw LLM response text
   * @param fallbackPrompt - Fallback prompt to use if parsing fails
   * @returns Parsed image generation parameters
   */
  private parseImageGenerationParams(
    llmResponse: string,
    fallbackPrompt: string,
  ): {
    prompt: string;
    negative_prompt: string;
    steps: number;
    cfg_scale: number;
    seed: number;
    width: number;
    height: number;
    sampler: string;
  } {
    try {
      // Try to extract JSON from the response
      // Handle cases where JSON might be wrapped in markdown code blocks
      let jsonText = llmResponse.trim();

      // Remove markdown code block markers if present
      const jsonBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        jsonText = jsonBlockMatch[1].trim();
      }

      // Try to find JSON object in the text
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }

      // Parse JSON
      const parsed = JSON.parse(jsonText);

      // Validate required fields
      if (!parsed.prompt || typeof parsed.prompt !== 'string') {
        throw new Error('Missing or invalid prompt field in LLM response');
      }

      // Extract and validate parameters with defaults
      const result = {
        prompt: parsed.prompt as string,
        negative_prompt: parsed.negative_prompt as string,
        steps: this.validateNumber(parsed.steps, 30, 1, 100),
        cfg_scale: this.validateNumber(parsed.cfg_scale, 7.5, 1, 20),
        seed: this.validateNumber(parsed.seed, -1, -1, Number.MAX_SAFE_INTEGER),
        width: this.validateNumber(parsed.width, 1024, 256, 2048),
        height: this.validateNumber(parsed.height, 1024, 256, 2048),
        sampler: (parsed.sampler as string) || 'Euler a',
      };

      logger.debug(`[AIService] Successfully parsed LLM response | prompt="${result.prompt.substring(0, 50)}..."`);

      return result;
    } catch (parseError) {
      const parseErr = parseError instanceof Error ? parseError : new Error('Unknown parsing error');
      logger.warn(
        `[AIService] Failed to parse LLM response, using fallback | error=${parseErr.message} | response=${llmResponse.substring(0, 200)}`,
      );

      // Fallback: Return default parameters with user input as prompt
      return {
        prompt: fallbackPrompt,
        negative_prompt:
          'worst quality, low quality, bad anatomy, bad hands, text, error, jpeg artifacts, signature, watermark, blurry',
        steps: 30,
        cfg_scale: 7.5,
        seed: -1,
        width: 1024,
        height: 1024,
        sampler: 'Euler a',
      };
    }
  }

  /**
   * Validate and normalize a number parameter
   * @param value - Value to validate
   * @param defaultValue - Default value if validation fails
   * @param min - Minimum allowed value
   * @param max - Maximum allowed value
   * @returns Validated number
   */
  private validateNumber(value: unknown, defaultValue: number, min: number, max: number): number {
    if (typeof value === 'number' && !isNaN(value)) {
      return Math.max(min, Math.min(max, value));
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed)) {
        return Math.max(min, Math.min(max, parsed));
      }
    }
    return defaultValue;
  }

  /**
   * Build conversation history for prompt
   * @param context - Hook context
   * @returns Conversation history
   */
  private buildConversationHistory(context: HookContext): string {
    const history = context.context?.history || [];
    const limitedHistory = history.slice(-this.maxHistoryMessages);
    return limitedHistory.map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n');
  }
}
