// AI Service - provides AI capabilities as a service

import { SubAgentExecutor } from '@/agent/SubAgentExecutor';
import { SubAgentManager } from '@/agent/SubAgentManager';
import { ToolRunner } from '@/agent/ToolRunner';
import type { SubAgentConfig, SubAgentType } from '@/agent/types';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { ProactiveReplyInjectContext } from '@/context/types';
import type { ConversationHistoryService } from '@/conversation/history';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import type { PluginManager } from '@/plugins/PluginManager';
import type { WhitelistPlugin } from '@/plugins/plugins/WhitelistPlugin';
import { CardRenderingService } from '@/services/card';
import type { RetrievalService } from '@/services/retrieval';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolResult } from '@/tools/types';
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
import { VisionService } from './services/VisionService';
import { buildSkillUsageInstructions, executeSkillCall, getReplySkillDefinitions } from './tools/replyTools';
import type { AIGenerateResponse, ChatMessage, ContentPart } from './types';
import { normalizeVisionImages } from './utils/imageUtils';

/**
 * AI Service
 * Provides AI capabilities as a service to other systems.
 * This is NOT a System - it's a service that can be called by systems.
 *
 * This service acts as a facade, delegating to specialized services:
 * - ReplyGenerationService: Handles all reply generation logic
 * - ImagePromptService: Handles image prompt preprocessing
 * - ImageGenerationService: Handles actual image generation
 * - ConversationHistoryService: Handles conversation history building
 *
 * Capabilities:
 * 1. generateReplyFromToolResults: Generate AI reply from task execution results (unified entry point)
 * 2. Image generation: Text-to-image and image-to-image
 *
 * Other systems (like ReplySystem) should inject this service to use AI capabilities.
 */
export class AIService {
  private llmService: LLMService;
  private visionService: VisionService;
  private imageGenerationService: ImageGenerationService;
  private cardRenderingService: CardRenderingService;
  private replyGenerationService: ReplyGenerationService;
  private imagePromptService: ImagePromptService;
  private messageAssembler: PromptMessageAssembler;
  private subAgentManager: SubAgentManager;
  /** Proactive reply: max history entries in prompt; aligned with ProactiveReplyContextBuilder (summarization when over limit). */
  private static readonly PROACTIVE_MAX_HISTORY_ENTRIES = 24;

  /** Resolved provider and tool/vision capabilities for one proactive generation. */
  private static readonly PROACTIVE_GEN_OPTIONS = {
    temperature: 0.5,
    maxTokens: 2000,
    maxToolRounds: 4,
  } as const;

  constructor(
    aiManager: AIManager,
    private hookManager: HookManager,
    private promptManager: PromptManager,
    private toolManager: ToolManager,
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

    // SubAgent: create manager, ToolRunner (executes tools via ToolManager executors), and executor
    const subAgentManager = new SubAgentManager();
    this.subAgentManager = subAgentManager;
    const subAgentToolSpecs = toolManager.getToolsByScope('subagent');
    const subAgentToolDefs = toolManager.toToolDefinitions(subAgentToolSpecs);
    const toolRunner = new ToolRunner(toolManager, subAgentManager, hookManager);
    const subAgentExecutor = new SubAgentExecutor(this.llmService, subAgentManager, subAgentToolDefs, toolRunner);
    subAgentManager.setExecutor(subAgentExecutor);

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
      toolManager,
    );
    this.messageAssembler = new PromptMessageAssembler();
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

  // --- Card rendering ---

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

  // --- Proactive reply: provider/capabilities and prompt building ---

  /**
   * Resolves effective provider and tool/vision capabilities for proactive reply.
   * When vision is used, provider may be switched to a vision-capable one; tool-use is checked for that provider.
   */
  private async resolveProactiveProviderAndCapabilities(
    context: ProactiveReplyInjectContext,
    providerName: string | undefined,
    useVision: boolean,
  ): Promise<{
    effectiveProviderName: string | undefined;
    canUseToolUse: boolean;
    nativeWebSearchEnabled: boolean;
  }> {
    const sessionId = context.sessionId;
    const effectiveProviderName = useVision
      ? ((await this.visionService.getAvailableProviderName(providerName, sessionId)) ?? providerName)
      : providerName;
    const canUseToolUse = useVision
      ? Boolean(effectiveProviderName && (await this.llmService.supportsToolUse(effectiveProviderName, sessionId)))
      : await this.llmService.supportsToolUse(effectiveProviderName, sessionId);
    const nativeWebSearchEnabled = canUseToolUse
      ? await this.llmService.supportsNativeWebSearch(effectiveProviderName, sessionId)
      : false;
    return { effectiveProviderName, canUseToolUse, nativeWebSearchEnabled };
  }

  /** Builds tool definitions and usage instruction string for proactive prompt. */
  private getProactiveToolsAndInstructions(
    canUseToolUse: boolean,
    nativeWebSearchEnabled: boolean,
  ): { tools: ReturnType<typeof getReplySkillDefinitions>; toolUsageInstructions: string } {
    if (!canUseToolUse) {
      return { tools: [], toolUsageInstructions: '当前没有可用工具，请直接回答。' };
    }
    const tools = getReplySkillDefinitions(this.toolManager, { nativeWebSearchEnabled });
    const toolUsageInstructions = buildSkillUsageInstructions(
      this.toolManager,
      tools,
      { nativeWebSearchEnabled },
      this.promptManager,
    );
    return { tools, toolUsageInstructions };
  }

  /** Builds base system, scene system prompt and final user query for proactive. */
  private buildProactivePrompts(
    context: ProactiveReplyInjectContext,
    toolUsageInstructions: string,
  ): { baseSystemPrompt: string; proactiveSystemPrompt: string; finalUserQuery: string } {
    let whitelistFragment = '';
    if (context.sessionId) {
      const pluginManager = getContainer().resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
      const whitelistPlugin = pluginManager?.getPluginAs<WhitelistPlugin>('whitelist');
      const caps = whitelistPlugin?.getGroupCapabilities?.(context.sessionId);
      if (caps && caps.length > 0) {
        const rendered = this.promptManager.render('llm.whitelist_limited.system');
        if (rendered?.trim()) {
          whitelistFragment = rendered.trim();
        }
      }
    }
    const baseSystemPrompt = this.promptManager.renderBasePrompt({ whitelistLimitedFragment: whitelistFragment }) ?? '';
    const contextInstruct = this.promptManager.render('llm.context.instruct');
    const toolInstruct = this.promptManager.render('llm.tool.instruct', { toolUsageInstructions });
    const proactiveSystemPrompt = this.promptManager.render('llm.proactive.system', {
      contextInstruct,
      preferenceText: context.preferenceText,
      toolInstruct,
    });
    const lastUserMessage = context.lastUserMessage?.trim() ?? '（无）';
    const finalUserQuery = this.promptManager.render('llm.proactive.user_frame', { lastUserMessage }) ?? '';
    return { baseSystemPrompt, proactiveSystemPrompt, finalUserQuery };
  }

  /** Caps history to last N entries and builds final user content blocks. */
  private getProactiveHistoryAndUserBlocks(
    context: ProactiveReplyInjectContext,
    finalUserQuery: string,
  ): {
    historyEntries: NonNullable<ProactiveReplyInjectContext['historyEntries']>;
    finalUserBlocks: { memoryContext: string; ragContext: string; searchResults: string; currentQuery: string };
  } {
    const rawHistory = context.historyEntries ?? [];
    const historyEntries =
      rawHistory.length <= AIService.PROACTIVE_MAX_HISTORY_ENTRIES
        ? rawHistory
        : rawHistory.slice(-AIService.PROACTIVE_MAX_HISTORY_ENTRIES);
    const finalUserBlocks = {
      memoryContext: context.memoryContext ?? '',
      ragContext: context.retrievedConversationSection ?? '',
      searchResults: context.retrievedContext ?? '',
      currentQuery: finalUserQuery,
    };
    return { historyEntries, finalUserBlocks };
  }

  /**
   * Runs the appropriate LLM/vision path: vision+tool, vision+no-tool, text+tool, text+no-tool.
   * Returns the raw AI response for the caller to trim.
   */
  private async executeProactiveLLM(
    messages: ChatMessage[],
    context: ProactiveReplyInjectContext,
    capabilities: {
      effectiveProviderName: string | undefined;
      canUseToolUse: boolean;
      nativeWebSearchEnabled: boolean;
    },
    tools: ReturnType<typeof getReplySkillDefinitions>,
    useVision: boolean,
  ): Promise<AIGenerateResponse> {
    const { effectiveProviderName, canUseToolUse, nativeWebSearchEnabled } = capabilities;
    const genOptions = {
      ...AIService.PROACTIVE_GEN_OPTIONS,
      sessionId: context.sessionId,
    };
    const lastUserMessage = context.lastUserMessage?.trim() ?? '（无）';
    const hookContext = this.buildProactiveToolHookContext(context, lastUserMessage);
    const toolExecutor = (call: { name: string; arguments: string }) =>
      executeSkillCall(call, hookContext, this.toolManager, this.hookManager);
    const useTools = canUseToolUse && effectiveProviderName && tools.length > 0;

    if (useVision) {
      if (useTools) {
        const toolUseResponse = await this.llmService.generateWithTools(
          messages,
          tools,
          {
            temperature: genOptions.temperature,
            maxTokens: genOptions.maxTokens,
            maxToolRounds: genOptions.maxToolRounds,
            sessionId: genOptions.sessionId,
            nativeWebSearch: nativeWebSearchEnabled,
            toolExecutor,
          },
          effectiveProviderName,
        );
        return { text: toolUseResponse.text };
      }
      return this.visionService.generateWithVisionMessages(
        messages,
        [],
        { temperature: genOptions.temperature, maxTokens: genOptions.maxTokens, sessionId: genOptions.sessionId },
        effectiveProviderName,
      );
    }
    if (useTools) {
      const toolUseResponse = await this.llmService.generateWithTools(
        messages,
        tools,
        {
          temperature: genOptions.temperature,
          maxTokens: genOptions.maxTokens,
          maxToolRounds: genOptions.maxToolRounds,
          sessionId: genOptions.sessionId,
          nativeWebSearch: nativeWebSearchEnabled,
          toolExecutor,
        },
        effectiveProviderName,
      );
      return { text: toolUseResponse.text };
    }
    return this.llmService.generateMessages(messages, genOptions, effectiveProviderName);
  }

  /**
   * Generate a single proactive reply for group participation.
   * All injectable text (preference, thread, RAG, memory) is provided via context from the context layer.
   * @param context - ProactiveReplyInjectContext built by ProactiveReplyContextBuilder
   * @param providerName - Optional LLM provider (e.g. "ollama", "doubao"); when set, reply uses this provider.
   */
  async generateProactiveReply(context: ProactiveReplyInjectContext, providerName?: string): Promise<string> {
    const useVision = Boolean(context.messageImages?.length);
    const capabilities = await this.resolveProactiveProviderAndCapabilities(context, providerName, useVision);
    const { tools, toolUsageInstructions } = this.getProactiveToolsAndInstructions(
      capabilities.canUseToolUse,
      capabilities.nativeWebSearchEnabled,
    );
    const { baseSystemPrompt, proactiveSystemPrompt, finalUserQuery } = this.buildProactivePrompts(
      context,
      toolUsageInstructions,
    );
    const { historyEntries, finalUserBlocks } = this.getProactiveHistoryAndUserBlocks(context, finalUserQuery);

    const messages = this.messageAssembler.buildProactiveMessages({
      baseSystem: baseSystemPrompt,
      sceneSystem: proactiveSystemPrompt,
      historyEntries,
      finalUserBlocks,
    });
    const proactiveMessages = useVision
      ? await this.attachVisionImagesToLastUserMessage(messages, context.messageImages ?? [])
      : messages;

    const response = await this.executeProactiveLLM(proactiveMessages, context, capabilities, tools, useVision);
    return response.text;
  }

  /**
   * Normalizes vision images and converts them to LLM content parts (image_url).
   * Used when attaching images to the last user message in proactive/vision flow.
   */
  private async visionImagesToContentParts(images: VisionImage[]): Promise<ContentPart[]> {
    const normalized = await normalizeVisionImages(images, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024,
    });
    return normalized
      .filter((img) => img.base64 || img.url)
      .map((img) => ({
        type: 'image_url' as const,
        image_url: {
          url: img.base64 ? `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` : (img.url ?? ''),
        },
      }));
  }

  /**
   * Appends vision images to the last message in the list (proactive flow).
   * If the last message has string content, prepends text then images; otherwise appends images to existing parts.
   */
  private async attachVisionImagesToLastUserMessage(
    messages: ChatMessage[],
    images: VisionImage[],
  ): Promise<ChatMessage[]> {
    if (messages.length === 0 || images.length === 0) {
      return messages;
    }
    const imageParts = await this.visionImagesToContentParts(images);
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

  /** Parses group ID from session ID string (e.g. "group:123" -> 123). */
  private parseGroupIdFromSessionId(sessionId: string): number {
    const match = /^group:(\d+)$/.exec(sessionId);
    return match ? parseInt(match[1], 10) : 0;
  }

  /** Maps proactive history entries to the format expected by HookContext conversation history. */
  private mapProactiveHistoryToConversationFormat(
    entries: ProactiveReplyInjectContext['historyEntries'],
  ): Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }> {
    const list = entries ?? [];
    return list.map((entry) => ({
      role: entry.isBotReply ? ('assistant' as const) : ('user' as const),
      content: entry.content,
      timestamp: entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt),
    }));
  }

  /** Builds HookContext for proactive tool execution (synthetic message + conversation context + metadata). */
  private buildProactiveToolHookContext(context: ProactiveReplyInjectContext, lastUserMessage: string): HookContext {
    const sessionId = context.sessionId ?? 'group:0';
    const groupId = this.parseGroupIdFromSessionId(sessionId);
    const history = this.mapProactiveHistoryToConversationFormat(context.historyEntries);

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

  // --- Reply / card processing ---

  /**
   * Optionally convert reply text to card and return segments + text for history.
   * Uses same pipeline as ReplyGenerationService.handleCardReply (no context). Proactive flow: send returned segments, persist textForHistory in thread/history.
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
    return this.replyGenerationService.handleCardReply(replyText, sessionId, { providerName });
  }

  // --- Vision (explain images) ---

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

  // --- Image generation: text2img ---

  /**
   * Runs the standard image-generation hook lifecycle: onMessageBeforeAI, onAIGenerationStart,
   * then the given async fn(sessionId); on success or failure calls onAIGenerationComplete.
   */
  private async runWithImageGenerationHooks<T>(
    context: HookContext,
    interruptMessage: string,
    fn: (sessionId: string | undefined) => Promise<T>,
  ): Promise<T> {
    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error(interruptMessage);
    }
    const sessionId = context.metadata.get('sessionId');
    await this.hookManager.execute('onAIGenerationStart', context);
    try {
      const result = await fn(sessionId);
      await this.hookManager.execute('onAIGenerationComplete', context);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[AIService] Image generation failed:', err);
      await this.hookManager.execute('onAIGenerationComplete', context);
      throw err;
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
    return this.runWithImageGenerationHooks(context, 'Image generation interrupted by hook', async (sessionId) => {
      if (!options?.prompt) {
        throw new Error('options.prompt must be provided by caller');
      }
      const userInput = options.prompt;
      logger.debug(
        `[AIService] Processing prompt | input=${userInput.substring(0, 50)}... | skipLLMProcess=${skipLLMProcess ?? false}`,
      );

      const prepared = await this.imagePromptService.prepareImageGenerationParams(
        userInput,
        options,
        sessionId ?? '',
        skipLLMProcess,
        templateName,
      );
      logger.info(
        `[AIService] Generating image | prompt="${prepared.prompt.substring(0, 100)}..." | providerName=${providerName ?? 'default'}`,
      );

      const response = await this.imageGenerationService.generateImage(
        prepared.prompt,
        prepared.options,
        sessionId,
        providerName,
      );
      response.prompt = prepared.prompt;
      return response;
    });
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

  // --- Image generation: img2img ---

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
    return this.runWithImageGenerationHooks(context, 'Image transformation interrupted by hook', async (sessionId) => {
      if (!prompt?.trim()) {
        throw new Error('prompt must be provided for image transformation');
      }
      const finalPrompt = await this.resolveImageToImagePrompt(prompt, sessionId, useLLMPreprocess, templateName);
      logger.info(
        `[AIService] Generating image from image | prompt="${finalPrompt}" | providerName=${providerName ?? 'default'}`,
      );
      return this.imageGenerationService.generateImageFromImage(image, finalPrompt, options, sessionId, providerName);
    });
  }

  /**
   * Resolves final prompt for image-to-image: optional LLM preprocessing when useLLMPreprocess is true.
   * Does not merge prepared options into img2img (NovelAI steps/scale/size stay fixed to avoid extra Anlas cost).
   */
  private async resolveImageToImagePrompt(
    prompt: string,
    sessionId: string | undefined,
    useLLMPreprocess?: boolean,
    templateName?: string,
  ): Promise<string> {
    if (!useLLMPreprocess) {
      return prompt;
    }
    const skipLLMProcess = false;
    const prepared = await this.imagePromptService.prepareImageGenerationParams(
      prompt,
      { prompt },
      sessionId ?? '',
      skipLLMProcess,
      templateName ?? 'text2img.generate',
    );
    logger.debug(`[AIService] Image-from-image LLM preprocessing | input="${prompt}"`);
    return prepared.prompt;
  }

  // --- Task-based reply (unified entry) ---

  /**
   * Generate reply from task results
   * This is the unified entry point for generating bot replies after task execution.
   * Handles all cases: with/without images, with/without task results, with/without search.
   *
   * @param context - Hook context containing message and conversation history
   * @param taskResults - Task execution results (empty Map if no tasks)
   */
  async generateReplyFromToolResults(context: HookContext, taskResults: Map<string, ToolResult>): Promise<void> {
    return await this.replyGenerationService.generateReplyFromToolResults(context, taskResults);
  }

  /**
   * Generate reply using unified skill loop (single LLM call with multi-round tool execution).
   * @param context - Hook context
   * @returns Reply text (sets context.reply)
   */
  async generateReplyWithSkills(context: HookContext): Promise<void> {
    await this.replyGenerationService.generateReplyFromToolResults(context, new Map());
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
