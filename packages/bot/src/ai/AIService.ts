// AI Service — pure facade delegating to specialized sub-services.

import { inject, singleton } from 'tsyringe';
import { SubAgentExecutor } from '@/agent/SubAgentExecutor';
import { SubAgentManager } from '@/agent/SubAgentManager';
import type { SubAgentConfig, SubAgentType } from '@/agent/types';
import { ProviderSelector } from '@/ai/ProviderSelector';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import { LLMService } from '@/ai/services/LLMService';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProactiveReplyInjectContext } from '@/context/types';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { PromptInjectionRegistry } from '@/conversation/promptInjection/PromptInjectionRegistry';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import { DatabaseManager } from '@/database/DatabaseManager';
import { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MemoryService } from '@/memory/MemoryService';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import type { PermissionChecker } from '@/permission';
import { type CardData, CardRenderingService } from '@/services/card';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { ToolManager } from '@/tools/ToolManager';
import type { ToolResult } from '@/tools/types';
import type { AIManager } from './AIManager';
import type { Image2ImageOptions, ImageGenerationResponse, Text2ImageOptions } from './capabilities/types';
import { CardRenderingHelper } from './pipeline/helpers/CardRenderingHelper';
import { EpisodeCacheManager } from './pipeline/helpers/EpisodeCacheManager';
import { ReplyPipelineOrchestrator } from './pipeline/ReplyPipelineOrchestrator';
import { ContextEnrichmentStage } from './pipeline/stages/ContextEnrichmentStage';
import { ContextResolutionStage } from './pipeline/stages/ContextResolutionStage';
import { GateCheckStage } from './pipeline/stages/GateCheckStage';
import { GenerationStage } from './pipeline/stages/GenerationStage';
import { HistoryStage } from './pipeline/stages/HistoryStage';
import { PromptAssemblyStage } from './pipeline/stages/PromptAssemblyStage';
import { ProviderSelectionStage } from './pipeline/stages/ProviderSelectionStage';
import { ResponseDispatchStage } from './pipeline/stages/ResponseDispatchStage';
import type { PromptManager } from './prompt/PromptManager';
import type { I2VPromptResult } from './schemas';
import { ImageFacadeService } from './services/ImageFacadeService';
import { ImageGenerationService } from './services/ImageGenerationService';
import { ImagePromptService } from './services/ImagePromptService';
import { NsfwReplyService } from './services/NsfwReplyService';
import { ProactiveReplyGenerationService } from './services/ProactiveReplyGenerationService';
import { VisionService } from './services/VisionService';
import type { AIGenerateResponse } from './types';

/**
 * AI Service — pure facade delegating to specialized sub-services.
 *
 * Sub-services:
 * - ReplyPipelineOrchestrator: Normal reply generation (stage-based pipeline)
 * - NsfwReplyService: NSFW-mode reply generation
 * - ProactiveReplyGenerationService: Proactive group reply generation
 * - ImageFacadeService: Image generation (text2img, img2img, i2v) with hook lifecycle
 * - SubAgentManager: Sub-agent spawning and execution
 *
 * Other systems (like ReplySystem) should inject this service to use AI capabilities.
 */
@singleton()
export class AIService {
  private replyPipeline: ReplyPipelineOrchestrator;
  private nsfwReplyService: NsfwReplyService;
  private proactiveReplyService: ProactiveReplyGenerationService;
  private imageFacadeService: ImageFacadeService;
  private cardRenderingService: CardRenderingService;
  private visionService: VisionService;

  constructor(
    @inject(DITokens.AI_MANAGER) aiManager: AIManager,
    @inject(HookManager) hookManager: HookManager,
    @inject(DITokens.PROMPT_MANAGER) promptManager: PromptManager,
    @inject(DITokens.TOOL_MANAGER) toolManager: ToolManager,
    @inject(ConversationHistoryService) conversationHistoryService: ConversationHistoryService,
    @inject(ProviderSelector) providerSelector: ProviderSelector,
    @inject(RetrievalService) retrievalService: RetrievalService,
    @inject(MemoryService) memoryService: MemoryService,
    @inject(MessageAPI) messageAPI: MessageAPI,
    @inject(DatabaseManager) databaseManager: DatabaseManager,
    @inject(LLMService) llmService: LLMService,
    @inject(ProviderRouter) providerRouter: ProviderRouter,
    @inject(DITokens.PERMISSION_CHECKER) permissionChecker: PermissionChecker,
    @inject(PromptInjectionRegistry) registry: PromptInjectionRegistry,
    @inject(DITokens.CONFIG) config: Config,
    @inject(SubAgentManager) private readonly subAgentManager: SubAgentManager,
    @inject(SubAgentExecutor) private readonly subAgentExecutor: SubAgentExecutor,
  ) {
    const aiConfig = config.getAIConfig();
    const chatConfig = aiConfig?.chat;

    this.visionService = new VisionService(aiManager, providerSelector);
    this.cardRenderingService = new CardRenderingService(aiManager);
    const imageGenerationService = new ImageGenerationService(aiManager, providerSelector);
    const imagePromptService = new ImagePromptService(
      llmService,
      promptManager,
      aiManager.getDefaultProvider('llm')?.name || 'deepseek',
    );

    // Reply generation pipeline
    const episodeCacheManager = new EpisodeCacheManager(conversationHistoryService);
    const cardHelper = new CardRenderingHelper(this.cardRenderingService, hookManager);
    const contextEnrichmentStage = new ContextEnrichmentStage(memoryService, retrievalService, promptManager);
    const stages = [
      new GateCheckStage(hookManager),
      new ContextResolutionStage(messageAPI, databaseManager),
      new HistoryStage(episodeCacheManager),
      contextEnrichmentStage,
      new ProviderSelectionStage(
        providerRouter,
        this.visionService,
        llmService,
        toolManager,
        promptManager,
        permissionChecker,
      ),
      new PromptAssemblyStage(registry, promptManager, messageAPI, chatConfig),
      new GenerationStage(llmService, toolManager, hookManager, messageAPI),
      new ResponseDispatchStage(cardHelper, hookManager),
    ];
    this.replyPipeline = new ReplyPipelineOrchestrator(stages, episodeCacheManager, cardHelper, hookManager);

    // NSFW reply
    this.nsfwReplyService = new NsfwReplyService(
      hookManager,
      llmService,
      conversationHistoryService,
      promptManager,
      contextEnrichmentStage,
    );

    // Proactive reply
    this.proactiveReplyService = new ProactiveReplyGenerationService(
      llmService,
      this.visionService,
      hookManager,
      promptManager,
      toolManager,
    );

    // Image generation
    this.imageFacadeService = new ImageFacadeService(hookManager, imageGenerationService, imagePromptService);
  }

  // --- Sub-agent ---

  async spawnSubAgent(
    type: SubAgentType,
    task: {
      description: string;
      input: unknown;
      parentContext?: {
        userId: number | string;
        groupId?: number | string;
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
        userId: number | string;
        groupId?: number | string;
        messageType: 'private' | 'group';
        protocol?: string;
        conversationId?: string;
        messageId?: string;
      };
    },
    configOverrides?: Partial<SubAgentConfig>,
    parentId?: string,
  ): Promise<string> {
    const sessionId = await this.subAgentManager.spawn(parentId, type, task, configOverrides);
    await this.subAgentExecutor.execute(sessionId);
    return this.subAgentManager.wait(sessionId);
  }

  // --- Card rendering ---

  async renderCardToSegments(cardJson: string, providerName?: string): Promise<MessageSegment[]> {
    const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
    const base64Image = await this.cardRenderingService.renderCard(cardJson, provider);
    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: base64Image });
    return messageBuilder.build();
  }

  /**
   * Render already-built card data to image segments. Use this for cards
   * constructed in code (e.g. /help): renderCardToSegments runs the LLM-text
   * JSON extractor, which mis-grabs nested arrays / bracketed substrings out of
   * a structured card. Pre-validated CardData must bypass that extraction.
   */
  async renderCardDataToSegments(cards: CardData | CardData[], providerName?: string): Promise<MessageSegment[]> {
    const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
    const deck = Array.isArray(cards) ? cards : [cards];
    const base64Image = await this.cardRenderingService.renderCardData(deck, provider);
    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: base64Image });
    return messageBuilder.build();
  }

  // --- Reply generation ---

  async generateReplyFromToolResults(context: HookContext, taskResults: Map<string, ToolResult>): Promise<void> {
    return this.replyPipeline.generateReplyFromToolResults(context, taskResults);
  }

  async generateReplyWithSkills(context: HookContext): Promise<void> {
    return this.replyPipeline.generateReplyFromToolResults(context, new Map());
  }

  async generateNsfwReply(context: HookContext, options?: { char?: string; instruct?: string }): Promise<void> {
    return this.nsfwReplyService.generateNsfwReply(context, options);
  }

  // --- Proactive reply ---

  async generateProactiveReply(
    context: ProactiveReplyInjectContext,
    providerName?: string,
  ): Promise<AIGenerateResponse> {
    return this.proactiveReplyService.generateProactiveReply(context, providerName);
  }

  async processReplyMaybeCard(
    replyText: string,
    sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    return this.replyPipeline.handleCardReply(replyText, sessionId, { providerName });
  }

  // --- Image generation ---

  async generateImg(
    context: HookContext,
    options: Text2ImageOptions,
    providerName?: string,
    skipLLMProcess?: boolean,
    templateName?: string,
  ): Promise<ImageGenerationResponse> {
    return this.imageFacadeService.generateImg(context, options, providerName, skipLLMProcess, templateName);
  }

  async generateImageFromImage(
    context: HookContext,
    images: string[],
    prompt: string,
    options?: Image2ImageOptions,
    providerName?: string,
    useLLMPreprocess?: boolean,
    templateName?: string,
  ): Promise<ImageGenerationResponse> {
    return this.imageFacadeService.generateImageFromImage(
      context,
      images,
      prompt,
      options,
      providerName,
      useLLMPreprocess,
      templateName,
    );
  }

  async prepareI2VPrompt(userInput: string, sessionId: string, templateName?: string): Promise<I2VPromptResult> {
    return this.imageFacadeService.prepareI2VPrompt(userInput, sessionId, templateName);
  }
}
