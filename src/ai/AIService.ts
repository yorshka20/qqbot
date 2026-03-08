// AI Service - provides AI capabilities as a service

import { SubAgentExecutor } from '@/agent/SubAgentExecutor';
import { SubAgentManager } from '@/agent/SubAgentManager';
import { ToolRunner } from '@/agent/ToolRunner';
import type { SubAgentConfig, SubAgentType } from '@/agent/types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { ProactiveReplyInjectContext } from '@/context/types';
import type { ConversationHistoryService } from '@/conversation/history';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import { CardRenderingService } from '@/services/card';
import type { RetrievalService } from '@/services/retrieval';
import { TaskAnalyzer } from '@/task/TaskAnalyzer';
import type { TaskManager } from '@/task/TaskManager';
import type { TaskAnalysisResult, TaskResult, TaskType } from '@/task/types';
import { logger } from '@/utils/logger';
import type { AIManager } from './AIManager';
import type { Image2ImageOptions, ImageGenerationResponse, Text2ImageOptions, VisionImage } from './capabilities/types';
import type { ProviderSelector } from './ProviderSelector';
import type { PromptManager } from './prompt/PromptManager';
import { PromptMessageAssembler } from './prompt/PromptMessageAssembler';
import { ProviderRouter } from './routing/ProviderRouter';
import type { I2VPromptResult } from './schemas';
import { ImageGenerationService } from './services/ImageGenerationService';
import { ImagePromptService } from './services/ImagePromptService';
import { LLMService } from './services/LLMService';
import { ReplyGenerationService } from './services/ReplyGenerationService';
import { ToolUseReplyService } from './services/ToolUseReplyService';
import { VisionService } from './services/VisionService';
import type { AIGenerateResponse, ChatMessage, ContentPart, ToolDefinition } from './types';
import { normalizeVisionImages } from './utils/imageUtils';

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
  private toolUseReplyService: ToolUseReplyService;
  private imagePromptService: ImagePromptService;
  private taskAnalyzer: TaskAnalyzer;
  private messageAssembler: PromptMessageAssembler;
  private subAgentManager: SubAgentManager;

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
    // SubAgent: create manager, ToolRunner (executes tools via TaskManager executors), and executor
    const subAgentManager = new SubAgentManager();
    this.subAgentManager = subAgentManager;
    const subAgentToolDefs = this.buildToolDefinitionsFromTaskTypes(
      taskManager.getAllTaskTypes().filter((tt) => tt.name !== 'reply'),
    );
    const toolRunner = new ToolRunner(taskManager, subAgentManager, hookManager);
    const subAgentExecutor = new SubAgentExecutor(this.llmService, subAgentManager, subAgentToolDefs, toolRunner);
    subAgentManager.setExecutor(subAgentExecutor);

    this.toolUseReplyService = new ToolUseReplyService(this.llmService, taskManager, this.promptManager, hookManager);
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
      this.toolUseReplyService,
    );
    this.taskAnalyzer = new TaskAnalyzer(this.llmService, taskManager, this.promptManager);
    this.messageAssembler = new PromptMessageAssembler();
  }

  /**
   * Build ToolDefinition[] from TaskType[] (for SubAgentExecutor and tool use)
   */
  private buildToolDefinitionsFromTaskTypes(taskTypes: TaskType[]): ToolDefinition[] {
    return taskTypes.map((tt) => ({
      name: tt.name,
      description: tt.description,
      parameters: this.convertTaskParamsToSchema(tt.parameters || {}),
    }));
  }

  private convertTaskParamsToSchema(params: TaskType['parameters']): ToolDefinition['parameters'] {
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    for (const [key, def] of Object.entries(params || {})) {
      properties[key] = { type: def.type, description: def.description || '' };
      if (def.required) {
        required.push(key);
      }
    }
    return { type: 'object', properties, required };
  }

  getSubAgentManager(): SubAgentManager {
    return this.subAgentManager;
  }

  async spawnSubAgent(
    type: SubAgentType,
    task: {
      description: string;
      input: unknown;
      parentContext?: {
        userId: number;
        groupId?: number;
        messageType: 'private' | 'group';
        protocol?: string;
        conversationId?: string;
        messageId?: string;
      };
    },
    configOverrides?: Partial<SubAgentConfig>,
    parentId?: string,
  ): Promise<string> {
    return this.subAgentManager.spawn(parentId, type, task, configOverrides);
  }

  async runSubAgent(
    type: SubAgentType,
    task: {
      description: string;
      input: unknown;
      parentContext?: {
        userId: number;
        groupId?: number;
        messageType: 'private' | 'group';
        protocol?: string;
        conversationId?: string;
        messageId?: string;
      };
    },
    configOverrides?: Partial<SubAgentConfig>,
    parentId?: string,
  ): Promise<unknown> {
    const sessionId = await this.subAgentManager.spawn(parentId, type, task, configOverrides);
    await this.subAgentManager.execute(sessionId);
    return this.subAgentManager.wait(sessionId);
  }

  /**
   * Render card JSON to image segments (same pipeline as ReplyGenerationService handleCardReply).
   * Use this when you have card-format JSON and want message segments for reply (e.g. help command).
   * @param cardJson - Valid card data JSON string (ListCardData, InfoCardData, etc.)
   * @param providerName - Provider name for card footer; when omitted, uses default LLM provider
   * @returns Message segments containing the card image, or throws if rendering fails
   */
  async renderCardToSegments(cardJson: string, providerName?: string): Promise<MessageSegment[]> {
    const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
    const base64Image = await this.cardRenderingService.renderCard(cardJson, provider);
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
    const lastUserMessage = context.lastUserMessage?.trim() ?? '（无）';
    const useVision = Boolean(context.messageImages?.length);
    const effectiveProviderName = useVision
      ? ((await this.visionService.getAvailableProviderName(providerName, context.sessionId)) ?? providerName)
      : providerName;
    const canUseToolUse = useVision
      ? Boolean(
          effectiveProviderName && (await this.llmService.supportsToolUse(effectiveProviderName, context.sessionId)),
        )
      : await this.llmService.supportsToolUse(effectiveProviderName, context.sessionId);
    const nativeWebSearchEnabled = canUseToolUse
      ? await this.llmService.supportsNativeWebSearch(effectiveProviderName, context.sessionId)
      : false;
    const tools = canUseToolUse ? this.toolUseReplyService.getAvailableToolDefinitions({ nativeWebSearchEnabled }) : [];
    const toolUsageInstructions = canUseToolUse
      ? this.toolUseReplyService.getToolUsageInstructions(tools, { nativeWebSearchEnabled })
      : '当前没有可用工具，请直接回答。';
    const sceneSystemPrompt = this.promptManager.render('llm.proactive.system', {
      preferenceText: context.preferenceText,
    });
    const proactiveSystemPrompt = canUseToolUse
      ? `${sceneSystemPrompt}\n\n${toolUsageInstructions}`
      : sceneSystemPrompt;
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
      sceneSystem: proactiveSystemPrompt,
      historyEntries,
      finalUserBlocks,
    });
    const proactiveMessages = useVision
      ? await this.attachVisionImagesToLastUserMessage(messages, context.messageImages ?? [])
      : messages;

    const proactiveHookContext = this.buildProactiveToolHookContext(context, lastUserMessage);
    let response: AIGenerateResponse;
    if (useVision) {
      if (canUseToolUse && effectiveProviderName) {
        const text = await this.toolUseReplyService.generateReplyFromMessages(proactiveHookContext, proactiveMessages, {
          tools,
          providerName: effectiveProviderName,
          sessionId: context.sessionId,
          temperature: genOptions.temperature,
          maxTokens: genOptions.maxTokens,
          maxToolRounds: 4,
          nativeWebSearchEnabled,
        });
        response = { text };
      } else {
        response = await this.visionService.generateWithVisionMessages(
          proactiveMessages,
          [],
          {
            ...genOptions,
          },
          effectiveProviderName,
        );
      }
    } else {
      if (canUseToolUse) {
        const text = await this.toolUseReplyService.generateReplyFromMessages(proactiveHookContext, proactiveMessages, {
          tools,
          providerName: effectiveProviderName,
          sessionId: context.sessionId,
          temperature: genOptions.temperature,
          maxTokens: genOptions.maxTokens,
          maxToolRounds: 4,
          nativeWebSearchEnabled,
        });
        response = { text };
      } else {
        response = await this.llmService.generateMessages(proactiveMessages, genOptions, effectiveProviderName);
      }
    }

    return response.text.trim();
  }

  private async attachVisionImagesToLastUserMessage(
    messages: ChatMessage[],
    images: VisionImage[],
  ): Promise<ChatMessage[]> {
    if (messages.length === 0 || images.length === 0) {
      return messages;
    }

    const normalized = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024,
    });
    const imageParts: ContentPart[] = normalized
      .filter((img) => img.base64 || img.url)
      .map((img) => ({
        type: 'image_url' as const,
        image_url: {
          url: img.base64 ? `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` : (img.url ?? ''),
        },
      }));
    if (imageParts.length === 0) {
      return messages;
    }

    const last = messages[messages.length - 1];
    const lastContent: ContentPart[] =
      typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }, ...imageParts]
        : [...(last.content ?? []), ...imageParts];
    return [...messages.slice(0, -1), { ...last, content: lastContent }];
  }

  private buildProactiveToolHookContext(context: ProactiveReplyInjectContext, lastUserMessage: string): HookContext {
    const sessionId = context.sessionId ?? 'group:0';
    const groupIdMatch = /^group:(\d+)$/.exec(sessionId);
    const groupId = groupIdMatch ? parseInt(groupIdMatch[1], 10) : 0;
    const history = (context.historyEntries ?? []).map((entry) => ({
      role: entry.isBotReply ? ('assistant' as const) : ('user' as const),
      content: entry.content,
      timestamp: entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt),
    }));

    return HookContextBuilder.create()
      .withSyntheticMessage({
        userId: 0,
        groupId,
        messageType: 'group',
        message: lastUserMessage,
        segments: [],
        protocol: 'milky',
      })
      .withConversationContext({
        userMessage: lastUserMessage,
        history,
        userId: 0,
        groupId,
        messageType: 'group',
        metadata: new Map(),
      })
      .withMetadata('sessionId', sessionId)
      .withMetadata('sessionType', 'group')
      .withMetadata('contextMode', 'proactive')
      .withMetadata('groupId', groupId)
      .withMetadata('userId', 0)
      .build();
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
   * Generate reply using native tool/function calling
   * This is the new approach that merges TaskAnalyzer and ReplyGenerationService into a single LLM call
   * @param context - Hook context
   * @returns Reply text (sets context.reply)
   */
  async generateReplyWithToolUse(context: HookContext): Promise<void> {
    await this.replyGenerationService.generateReplyFromTaskResults(context, new Map());
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
