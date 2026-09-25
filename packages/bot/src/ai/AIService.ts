// AI Service — pure facade delegating to specialized sub-services.

import { inject, singleton } from 'tsyringe';
import type { ProactiveReplyInjectContext } from '@/context/types';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import type { CardData } from '@/services/card';
import { CardRenderingService } from '@/services/card/CardRenderingService';
import type { ToolResult } from '@/tools/types';
import type { Image2ImageOptions, ImageGenerationResponse, Text2ImageOptions } from './capabilities/types';
import { ReplyPipelineOrchestrator } from './pipeline/ReplyPipelineOrchestrator';
import type { I2VPromptResult } from './schemas';
import { ImageFacadeService } from './services/ImageFacadeService';
import { NsfwReplyService } from './services/NsfwReplyService';
import { ProactiveReplyGenerationService } from './services/ProactiveReplyGenerationService';
import type { AIGenerateResponse } from './types';

/**
 * AI Service — pure facade delegating to specialized sub-services.
 *
 * Sub-services:
 * - ReplyPipelineOrchestrator: Normal reply generation (stage-based pipeline)
 * - NsfwReplyService: NSFW-mode reply generation
 * - ProactiveReplyGenerationService: Proactive group reply generation
 * - ImageFacadeService: Image generation (text2img, img2img, i2v) with hook lifecycle
 *
 * Other systems (like ReplySystem) should inject this service to use AI capabilities.
 */
@singleton()
export class AIService {
  constructor(
    @inject(ReplyPipelineOrchestrator) private readonly replyPipeline: ReplyPipelineOrchestrator,
    @inject(NsfwReplyService) private readonly nsfwReplyService: NsfwReplyService,
    @inject(ProactiveReplyGenerationService) private readonly proactiveReplyService: ProactiveReplyGenerationService,
    @inject(ImageFacadeService) private readonly imageFacadeService: ImageFacadeService,
    @inject(CardRenderingService) private readonly cardRenderingService: CardRenderingService,
  ) {}

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
