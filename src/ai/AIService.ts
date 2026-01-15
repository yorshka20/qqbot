// AI Service - provides AI capabilities as a service

import type { ContextManager } from '@/context/ContextManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { SearchService } from '@/search';
import type { TaskAnalyzer } from '@/task/TaskAnalyzer';
import type { Task } from '@/task/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { ImageGenerationResponse, Text2ImageOptions, VisionImage } from './capabilities/types';
import { PromptManager } from './PromptManager';
import type { ProviderSelector } from './ProviderSelector';
import { CardRenderingService } from './services/CardRenderingService';
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
  private cardRenderingService: CardRenderingService;

  // Constants for parameter limits (NovelAI specific)
  private static readonly MAX_STEPS = 50;
  private static readonly MAX_GUIDANCE_SCALE = 9;
  private static readonly DEFAULT_STEPS = 45;
  private static readonly DEFAULT_GUIDANCE_SCALE = 7;
  private static readonly DEFAULT_WIDTH = 832;
  private static readonly DEFAULT_HEIGHT = 1216;

  constructor(
    private aiManager: AIManager,
    private contextManager: ContextManager,
    private hookManager: HookManager,
    private promptManager: PromptManager, // Required: must be provided from DI container
    private taskAnalyzer?: TaskAnalyzer, // Optional: only used if TaskAnalyzer is available
    private maxHistoryMessages = 10, // Maximum number of history messages to include in prompt
    providerSelector?: ProviderSelector, // Optional: for session-level provider selection
    private searchService?: SearchService, // Optional: search service for RAG
  ) {
    // Initialize business services
    this.llmService = new LLMService(aiManager, providerSelector);
    this.visionService = new VisionService(aiManager, providerSelector);
    this.imageGenerationService = new ImageGenerationService(aiManager, providerSelector);
    this.cardRenderingService = new CardRenderingService(aiManager);
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
   * Implements two-step process: 1) Check if search is needed, 2) Generate reply with or without search results
   * Supports card rendering for non-local providers when response is long
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
      const historyText = this.buildConversationHistory(context);

      // Get session ID for provider selection and context loading
      const sessionId = context.metadata.get('sessionId') as string | undefined;

      // Check if card format prompt should be used
      const useCardFormat = this.cardRenderingService.shouldUseCardFormatPrompt(sessionId);

      // Perform smart search if search service is available
      const searchResultsText = this.searchService
        ? await this.searchService.performSmartSearch(context.message.message, this.llmService, sessionId)
        : '';

      // Generate reply with or without search results
      // Use card format prompt for non-local providers
      let prompt: string;
      let shouldUseCardPrompt = useCardFormat;

      if (useCardFormat) {
        if (searchResultsText) {
          // Use card format prompt with search results
          prompt = this.promptManager.render('llm.reply.card.with_search', {
            userMessage: context.message.message,
            conversationHistory: historyText,
            searchResults: searchResultsText,
          });
        } else {
          prompt = this.promptManager.render('llm.reply.card', {
            userMessage: context.message.message,
            conversationHistory: historyText,
          });
        }
      } else {
        // For local providers, use standard prompt
        if (searchResultsText) {
          prompt = this.promptManager.render('llm.reply.with_search', {
            userMessage: context.message.message,
            conversationHistory: historyText,
            searchResults: searchResultsText,
          });
        } else {
          prompt = this.promptManager.render('llm.reply', {
            userMessage: context.message.message,
            conversationHistory: historyText,
          });
        }
      }

      // Generate AI response using LLM service
      const response = await this.llmService.generate(prompt, {
        temperature: 0.7,
        maxTokens: 2000,
        sessionId,
      });

      logger.debug(
        `[AIService] LLM response received | useCardFormat=${useCardFormat} | shouldUseCardPrompt=${shouldUseCardPrompt} | responseLength=${response.text.length}`,
      );

      // Check if we should render as card using CardRenderingService
      if (shouldUseCardPrompt) {
        const shouldRender = this.cardRenderingService.shouldUseCardRendering(response.text, sessionId);
        logger.debug(
          `[AIService] Card rendering check | shouldRender=${shouldRender} | responseLength=${response.text.length}`,
        );

        if (shouldRender) {
          try {
            logger.info('[AIService] Rendering card image for response');
            // Render card to image using CardRenderingService
            const base64Image = await this.cardRenderingService.renderCard(response.text);

            // Store image data in context metadata
            context.metadata.set('cardImage', base64Image);
            context.metadata.set('isCardImage', true);

            logger.info('[AIService] Card image rendered and stored in metadata');
            // Return empty string as the actual message will be sent as image
            return '';
          } catch (cardError) {
            const cardErr = cardError instanceof Error ? cardError : new Error('Unknown card error');
            logger.error('[AIService] Failed to render card:', cardErr);
            logger.error(`[AIService] Response text (first 500 chars): ${response.text.substring(0, 500)}`);
            // According to user requirement: force_json - throw error if JSON parsing fails
            throw cardErr;
          }
        } else {
          logger.debug(
            `[AIService] Card rendering skipped | reason: shouldUseCardRendering returned false | responseLength=${response.text.length}`,
          );
        }
      }

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
   * @param context - Hook context containing message and metadata
   * @param options - Image generation options (width, height, steps, etc.)
   * @param providerName - Optional provider name to use (e.g., 'novelai', 'local-text2img'). If not specified, uses default provider.
   * @param skipLLMProcess - If true, skip LLM preprocessing and use user input directly as prompt
   * @param templateName - Optional template name for LLM preprocessing (default: 'text2img.generate')
   */
  async generateImg(
    context: HookContext,
    options?: Text2ImageOptions,
    providerName?: string,
    skipLLMProcess?: boolean,
    templateName?: string,
  ): Promise<ImageGenerationResponse> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('Image generation interrupted by hook');
    }

    // Get session ID for provider selection
    const sessionId = context.metadata.get('sessionId') as string;
    const userInput = context.message.message;

    // Build context if not already built
    if (!context.context) {
      const conversationContext = this.contextManager.buildContext(userInput, {
        sessionId,
        sessionType: context.metadata.get('sessionType') as 'user' | 'group',
        userId: context.message.userId,
        groupId: context.message.groupId,
      });
      context.context = conversationContext;
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      logger.debug(
        `[AIService] Processing image generation request | userInput=${userInput.substring(0, 50)}... | skipLLMProcess=${skipLLMProcess || false}`,
      );

      // Prepare image generation parameters (with or without LLM preprocessing)
      const { prompt: processedPrompt, options: processedOptions } = await this.prepareImageGenerationParams(
        userInput,
        options,
        sessionId,
        skipLLMProcess,
        templateName, // Use specified template or default
      );

      // Generate image using ImageGenerationService with processed parameters
      logger.info(
        `[AIService] Generating image | prompt="${processedPrompt}" | options=${JSON.stringify(processedOptions)} | providerName=${providerName || 'default'}`,
      );

      const response = await this.imageGenerationService.generateImage(
        processedPrompt,
        processedOptions,
        sessionId,
        providerName,
      );

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
   * Prepare image generation parameters
   * Either uses LLM preprocessing or directly uses user input based on skipLLMProcess flag
   * @param userInput - User input text
   * @param options - User-provided options
   * @param sessionId - Session ID for provider selection
   * @param skipLLMProcess - Whether to skip LLM preprocessing
   * @param templateName - Optional template name for LLM preprocessing (default: 'text2img.generate')
   * @returns Processed prompt and options
   */
  private async prepareImageGenerationParams(
    userInput: string,
    options: Text2ImageOptions | undefined,
    sessionId: string | undefined,
    skipLLMProcess?: boolean,
    templateName?: string,
  ): Promise<{ prompt: string; options: Text2ImageOptions }> {
    if (skipLLMProcess) {
      return this.prepareDirectPrompt(userInput, options);
    }

    try {
      return await this.preprocessPromptWithLLM(userInput, options, sessionId, templateName);
    } catch (llmError) {
      const llmErr = llmError instanceof Error ? llmError : new Error('Unknown LLM error');
      logger.warn(`[AIService] LLM preprocessing failed, falling back to direct user input | error=${llmErr.message}`);
      return this.prepareDirectPrompt(userInput, options);
    }
  }

  /**
   * Preprocess user input using LLM to generate standardized image generation parameters
   * @param userInput - User input text
   * @param options - User-provided options (will be merged with LLM-generated options)
   * @param sessionId - Session ID for provider selection
   * @param templateName - Optional template name (default: 'text2img.generate')
   * @returns Processed prompt and options
   */
  private async preprocessPromptWithLLM(
    userInput: string,
    options: Text2ImageOptions | undefined,
    sessionId: string | undefined,
    templateName: string = 'text2img.generate',
  ): Promise<{ prompt: string; options: Text2ImageOptions }> {
    // Build LLM prompt using PromptManager
    // Default template name: 'text2img.generate' (from prompts/text2img/generate.txt)
    // Can be overridden with templateName parameter (e.g., 'text2img.generate_nai')
    const llmPrompt = this.promptManager.render(templateName, {
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

    // Parse LLM response to extract image generation parameters
    const parsedParams = this.parseImageGenerationParams(llmResponse.text, userInput);

    const processedOptions: Text2ImageOptions = {
      steps: parsedParams.steps,
      guidance_scale: parsedParams.cfg_scale,
      seed: parsedParams.seed,
      width: parsedParams.width,
      height: parsedParams.height,
      negative_prompt: parsedParams.negative_prompt,
      sampler: parsedParams.sampler,
      // Merge with user-provided options (user options take precedence)
      ...options,
    };

    logger.info(
      `[AIService] LLM preprocessing completed | original="${userInput.substring(0, 50)}..." | processed="${parsedParams.prompt.substring(0, 50)}..." | steps=${processedOptions.steps} | cfg=${processedOptions.guidance_scale}`,
    );

    return {
      prompt: parsedParams.prompt,
      options: processedOptions,
    };
  }

  /**
   * Prepare prompt and options directly from user input (skip LLM processing)
   * @param userInput - User input text
   * @param options - User-provided options
   * @returns Processed prompt and options
   */
  private prepareDirectPrompt(
    userInput: string,
    options: Text2ImageOptions | undefined,
  ): { prompt: string; options: Text2ImageOptions } {
    logger.debug('[AIService] Using direct user input as prompt (LLM processing skipped)');

    const processedOptions = this.mergeAndValidateOptions(options);

    logger.info('[AIService] Using direct user input as prompt');

    return {
      prompt: userInput,
      options: processedOptions,
    };
  }

  /**
   * Merge user-provided options with defaults and apply validation limits
   * @param options - User-provided options
   * @returns Merged and validated options
   */
  private mergeAndValidateOptions(options: Text2ImageOptions | undefined): Text2ImageOptions {
    const mergedOptions = {
      seed: -1,
      width: options?.width || AIService.DEFAULT_WIDTH,
      height: options?.height || AIService.DEFAULT_HEIGHT,
      ...options, // Merge user-provided options
    };

    // Apply limits to steps and guidance_scale after merge
    return {
      ...mergedOptions,
      steps: Math.min(mergedOptions.steps || AIService.DEFAULT_STEPS, AIService.MAX_STEPS),
      guidance_scale: Math.min(
        mergedOptions.guidance_scale || AIService.DEFAULT_GUIDANCE_SCALE,
        AIService.MAX_GUIDANCE_SCALE,
      ),
    };
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
      // Limit steps and cfg_scale to reasonable values (NovelAI typically uses steps 28-50, cfg 5-11)
      const result = {
        prompt: parsed.prompt as string,
        negative_prompt: (parsed.negative_prompt as string) || '',
        steps: this.validateNumber(parsed.steps, AIService.DEFAULT_STEPS, 1, AIService.MAX_STEPS),
        cfg_scale: this.validateNumber(
          parsed.cfg_scale,
          AIService.DEFAULT_GUIDANCE_SCALE,
          1,
          AIService.MAX_GUIDANCE_SCALE,
        ),
        seed: this.validateNumber(parsed.seed, -1, -1, Number.MAX_SAFE_INTEGER),
        width: this.validateNumber(parsed.width, AIService.DEFAULT_WIDTH, 256, 2048),
        height: this.validateNumber(parsed.height, AIService.DEFAULT_HEIGHT, 256, 2048),
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
        steps: AIService.DEFAULT_STEPS,
        cfg_scale: AIService.DEFAULT_GUIDANCE_SCALE,
        seed: -1,
        width: AIService.DEFAULT_WIDTH,
        height: AIService.DEFAULT_HEIGHT,
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
