// AI Service - provides AI capabilities as a service

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProactiveReplyInjectContext } from '@/context/types';
import type { ConversationHistoryService } from '@/conversation/history';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import type { RetrievalService } from '@/services/retrieval';
import { TaskAnalyzer } from '@/task/TaskAnalyzer';
import type { TaskManager } from '@/task/TaskManager';
import type { TaskAnalysisResult, TaskResult } from '@/task/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { Image2ImageOptions, ImageGenerationResponse, Text2ImageOptions, VisionImage } from './capabilities/types';
import type { ProviderSelector } from './ProviderSelector';
import type { PromptManager } from './prompt/PromptManager';
import { PromptMessageAssembler } from './prompt/PromptMessageAssembler';
import { ProviderRouter } from './routing/ProviderRouter';
import type { I2VPromptResult } from './schemas';
import { CardRenderingService } from './services/CardRenderingService';
import { ImageGenerationService } from './services/ImageGenerationService';
import { ImagePromptService } from './services/ImagePromptService';
import { LLMService } from './services/LLMService';
import { ReplyGenerationService } from './services/ReplyGenerationService';
import { VisionService } from './services/VisionService';
import type { AIGenerateResponse } from './types';

/**
 * AI Service
 * Provides AI capabilities as a service to other systems.
 * This is NOT a System - it's a service that can be called by systems.
 *
 * This service acts as a facade, delegating to specialized services:
 * - TaskAnalyzer: Handles AI-based task analysis (with hooks in this facade)
 * - ReplyGenerationService: Handles all reply generation logic
 * - ImagePromptService: Handles image prompt preprocessing
 * - ImageGenerationService: Handles actual image generation
 * - ConversationHistoryService: Handles conversation history building
 *
 * Capabilities:
 * 1. analyzeTask: Analyze user input and generate tasks
 * 2. generateReplyFromTaskResults: Generate AI reply from task execution results (unified entry point)
 * 3. Image generation: Text-to-image and image-to-image
 *
 * Other systems (like TaskSystem) should inject this service to use AI capabilities.
 */
export class AIService {
  private llmService: LLMService;
  private visionService: VisionService;
  private imageGenerationService: ImageGenerationService;
  private cardRenderingService: CardRenderingService;
  private replyGenerationService: ReplyGenerationService;
  private imagePromptService: ImagePromptService;
  private taskAnalyzer: TaskAnalyzer;
  private messageAssembler: PromptMessageAssembler;

  constructor(
    aiManager: AIManager,
    private hookManager: HookManager,
    private promptManager: PromptManager,
    taskManager: TaskManager,
    private conversationHistoryService: ConversationHistoryService,
    providerSelector: ProviderSelector,
    private retrievalService: RetrievalService,
    memoryService: MemoryService,
    messageAPI: MessageAPI,
    databaseManager: DatabaseManager,
  ) {
    // Initialize business services
    this.llmService = new LLMService(aiManager, providerSelector);
    this.visionService = new VisionService(aiManager, providerSelector);
    this.imageGenerationService = new ImageGenerationService(aiManager, providerSelector);
    this.cardRenderingService = new CardRenderingService(aiManager);
    this.imagePromptService = new ImagePromptService(
      this.llmService,
      this.promptManager,
      aiManager.getDefaultProvider('llm')?.name || 'deepseek',
    );
    this.replyGenerationService = new ReplyGenerationService(
      this.llmService,
      this.visionService,
      this.cardRenderingService,
      new ProviderRouter(aiManager),
      this.promptManager,
      this.hookManager,
      this.conversationHistoryService,
      this.retrievalService,
      memoryService,
      messageAPI,
      databaseManager,
    );
    this.taskAnalyzer = new TaskAnalyzer(this.llmService, taskManager, this.promptManager);
    this.messageAssembler = new PromptMessageAssembler();
  }

  /**
   * Render card JSON to image segments (same pipeline as ReplyGenerationService handleCardReply).
   * Use this when you have card-format JSON and want message segments for reply (e.g. help command).
   * @param cardJson - Valid card data JSON string (ListCardData, InfoCardData, etc.)
   * @returns Message segments containing the card image, or throws if rendering fails
   */
  async renderCardToSegments(cardJson: string): Promise<MessageSegment[]> {
    const base64Image = await this.cardRenderingService.renderCard(cardJson);
    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: base64Image });
    return messageBuilder.build();
  }

  /**
   * Analyze user input and generate tasks
   * This method can be called by other systems (e.g., TaskSystem) to analyze and generate tasks
   * Returns task array (excluding reply task which is always generated by system)
   */
  async analyzeTask(context: HookContext): Promise<TaskAnalysisResult> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      return { tasks: [] };
    }
    await this.hookManager.execute('onAIGenerationStart', context);
    try {
      const result = await this.taskAnalyzer.analyze(context.context);
      await this.hookManager.execute('onAIGenerationComplete', context);
      return result;
    } catch (error) {
      logger.warn('[AIService] Task analysis failed:', error);
      await this.hookManager.execute('onAIGenerationComplete', context);
      return { tasks: [] };
    }
  }

  /** Proactive reply: max history entries in prompt; aligned with ProactiveReplyContextBuilder (summarization when over limit). */
  private static readonly PROACTIVE_MAX_HISTORY_ENTRIES = 24;

  /**
   * Generate a single proactive reply for group participation.
   * All injectable text (preference, thread, RAG, memory) is provided via context from the context layer.
   * @param context - ProactiveReplyInjectContext built by ProactiveReplyContextBuilder
   * @param providerName - Optional LLM provider (e.g. "ollama", "doubao"); when set, reply uses this provider.
   */
  async generateProactiveReply(context: ProactiveReplyInjectContext, providerName?: string): Promise<string> {
    const genOptions = {
      temperature: 0.5,
      maxTokens: 2000,
      sessionId: context.sessionId,
    };
    const baseSystemPrompt = this.promptManager.renderBasePrompt();
    const sceneSystemPrompt = this.promptManager.render('llm.proactive.system', {
      preferenceText: context.preferenceText,
    });
    const lastUserMessage = context.lastUserMessage?.trim() ?? '（无）';
    const finalUserQuery = this.promptManager.render('llm.proactive.user_frame', {
      lastUserMessage,
    });
    // Scope history to last N entries so prompt reflects "thread recent" context, not entire thread from start
    const rawHistory = context.historyEntries ?? [];
    const historyEntries =
      rawHistory.length <= AIService.PROACTIVE_MAX_HISTORY_ENTRIES
        ? rawHistory
        : rawHistory.slice(-AIService.PROACTIVE_MAX_HISTORY_ENTRIES);

    const memoryContext = context.memoryContext ?? '';
    const ragContext = context.retrievedConversationSection ?? '';
    const searchResults = context.retrievedContext ?? '';

    const finalUserBlocks = {
      memoryContext,
      ragContext,
      searchResults,
      currentQuery: finalUserQuery,
    };

    const messages = this.messageAssembler.buildProactiveMessages({
      baseSystem: baseSystemPrompt,
      sceneSystem: sceneSystemPrompt,
      historyEntries,
      finalUserBlocks,
    });

    const useVision = context.messageImages && context.messageImages.length > 0;
    let response: AIGenerateResponse;
    if (useVision) {
      const flattenedPrompt = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
      response = await this.visionService.generateWithVision(flattenedPrompt, context.messageImages ?? [], {
        ...genOptions,
      });
    } else {
      response = await this.llmService.generateMessages(messages, genOptions, providerName);
    }

    return response.text.trim();
  }

  /**
   * Optionally convert reply text to card and return segments + text for history.
   * Used by proactive reply flow: send returned segments, persist textForHistory in thread/history.
   * @param replyText - Raw reply text from LLM
   * @param sessionId - Session ID (e.g. groupId for proactive)
   * @param providerName - Optional provider name (e.g. analysisProviderName for proactive)
   * @returns { segments, textForHistory } when card rendered; null to use replyText as-is for both send and history
   */
  async processReplyMaybeCard(
    replyText: string,
    sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    return this.replyGenerationService.processReplyMaybeCard(replyText, sessionId, providerName);
  }

  /**
   * Explain image(s) using vision provider. Returns combined description text (e.g. for task executor or other callers).
   */
  async explainImages(images: VisionImage[], userDescription: string, sessionId?: string): Promise<string> {
    if (!images.length) {
      return '';
    }
    try {
      const prompt = this.promptManager.render('vision.explain_image', {
        userDescription: userDescription || '（无）',
      });
      const response = await this.visionService.explainImages(images, prompt, {
        temperature: 0.3,
        maxTokens: 2000,
        sessionId,
      });
      return response.text?.trim() ?? '';
    } catch (error) {
      logger.warn('[AIService] explainImages failed:', error instanceof Error ? error.message : String(error));
      return '';
    }
  }

  /**
   * Generate image from text prompt
   *
   * Prompt must be provided in options.prompt by the caller.
   * LLM preprocessing is controlled by skipLLMProcess parameter:
   * - If skipLLMProcess is true, use options.prompt directly as final prompt (no LLM preprocessing)
   * - If skipLLMProcess is false/undefined, perform LLM preprocessing on options.prompt
   *
   * @param context - Hook context containing metadata (message is not used)
   * @param options - Image generation options. options.prompt must be provided by caller
   * @param providerName - Optional provider name to use (e.g., 'novelai', 'local-text2img')
   * @param skipLLMProcess - If true, skip LLM preprocessing and use options.prompt directly
   * @param templateName - Optional template name for LLM preprocessing (default: 'text2img.generate')
   * @returns Image generation response with processed prompt included for batch generation reuse
   */
  async generateImg(
    context: HookContext,
    options: Text2ImageOptions,
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
    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    if (!sessionId || !sessionType) {
      throw new Error('sessionId and sessionType must be set in metadata');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      // Prompt must be provided in options.prompt by caller
      if (!options?.prompt) {
        throw new Error('options.prompt must be provided by caller');
      }

      const userInput = options.prompt;

      logger.debug(
        `[AIService] Processing prompt | input=${userInput.substring(0, 50)}... | skipLLMProcess=${skipLLMProcess || false}`,
      );

      // Prepare parameters (with or without LLM preprocessing based on skipLLMProcess)
      const prepared = await this.imagePromptService.prepareImageGenerationParams(
        userInput,
        options,
        sessionId,
        skipLLMProcess,
        templateName,
      );

      const finalPrompt = prepared.prompt;
      const finalOptions = prepared.options;

      logger.info(
        `[AIService] Generating image | prompt="${finalPrompt.substring(0, 100)}..." | providerName=${providerName || 'default'}`,
      );

      // Generate image using ImageGenerationService
      const response = await this.imageGenerationService.generateImage(
        finalPrompt,
        finalOptions,
        sessionId,
        providerName,
      );

      // Include processed prompt in response for batch generation reuse
      response.prompt = finalPrompt;

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
   * Prepare prompt and duration for image-to-video (I2V) using LLM and template.
   * Used by the i2v command to convert user input into a Wan2.2-suitable motion prompt and duration (1–30s).
   * @param userInput - User description (can be empty)
   * @param sessionId - Session ID for LLM provider selection
   * @param templateName - Template name (default: 'img2video.generate')
   * @returns Processed prompt and durationSeconds (default 5, clamped 1–30)
   */
  async prepareI2VPrompt(userInput: string, sessionId: string, templateName?: string): Promise<I2VPromptResult> {
    return this.imagePromptService.prepareI2VPrompt(userInput, sessionId, templateName ?? 'img2video.generate');
  }

  /**
   * Transform image based on prompt (image-to-image)
   *
   * Prompt must be provided as a separate parameter.
   * When useLLMPreprocess is true, the prompt is optimized by LLM before generation (same as text2img path).
   *
   * @param context - Hook context containing metadata (message is not used)
   * @param image - Image input (URL, base64, or file path)
   * @param prompt - Text prompt for image transformation (user input)
   * @param options - Image transformation options
   * @param providerName - Optional provider name to use (e.g., 'laozhang')
   * @param useLLMPreprocess - If true, run LLM to optimize prompt before generation (default false)
   * @param templateName - Template name for LLM preprocessing when useLLMPreprocess is true (e.g. 'text2img.generate_nai')
   * @returns Image generation response
   */
  async generateImageFromImage(
    context: HookContext,
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
    providerName?: string,
    useLLMPreprocess?: boolean,
    templateName?: string,
  ): Promise<ImageGenerationResponse> {
    // Hook: onMessageBeforeAI
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('Image transformation interrupted by hook');
    }

    // Get session ID for provider selection
    const sessionId = context.metadata.get('sessionId');
    const sessionType = context.metadata.get('sessionType');
    if (!sessionId || !sessionType) {
      throw new Error('sessionId and sessionType must be set in metadata');
    }

    // Hook: onAIGenerationStart
    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      if (!prompt || prompt.trim().length === 0) {
        throw new Error('prompt must be provided for image transformation');
      }

      let finalPrompt = prompt;
      if (useLLMPreprocess) {
        const prepared = await this.imagePromptService.prepareImageGenerationParams(
          prompt,
          { prompt },
          sessionId,
          false,
          templateName ?? 'text2img.generate',
        );
        finalPrompt = prepared.prompt;
        // Do not merge prepared.options into img2img: NovelAI steps/scale/size must stay fixed to avoid extra Anlas cost.
        logger.debug(`[AIService] Image-from-image LLM preprocessing | input="${prompt}"`);
      }

      logger.info(
        `[AIService] Generating image from image | prompt="${finalPrompt}" | providerName=${providerName || 'default'}`,
      );

      // Generate image from image using ImageGenerationService
      const response = await this.imageGenerationService.generateImageFromImage(
        image,
        finalPrompt,
        options,
        sessionId,
        providerName,
      );

      // Hook: onAIGenerationComplete
      await this.hookManager.execute('onAIGenerationComplete', context);

      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AIService] Failed to generate image from image:', err);
      // Hook: onAIGenerationComplete (even on error)
      await this.hookManager.execute('onAIGenerationComplete', context);
      throw err;
    }
  }

  /**
   * Generate reply from task results
   * This is the unified entry point for generating bot replies after task execution.
   * Handles all cases: with/without images, with/without task results, with/without search.
   *
   * @param context - Hook context containing message and conversation history
   * @param taskResults - Task execution results (empty Map if no tasks)
   */
  async generateReplyFromTaskResults(context: HookContext, taskResults: Map<string, TaskResult>): Promise<void> {
    return await this.replyGenerationService.generateReplyFromTaskResults(context, taskResults);
  }

  /**
   * Generate reply using NSFW-mode prompt template only (fixed reply flow).
   * Used when session is in NSFW mode (e.g. by NsfwModePlugin interceptor).
   * Caller may pass options.char and options.instruct (e.g. from session config /nsfw --char=xxx --instruct=xxx) for the prompt template.
   */
  async generateNsfwReply(context: HookContext, options?: { char?: string; instruct?: string }): Promise<void> {
    return await this.replyGenerationService.generateNsfwReply(context, options);
  }
}
