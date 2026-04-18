// Card rendering helper — shared card rendering, conversion, detection, and extraction logic.

import { replaceReplyWithSegments } from '@/context/HookContextHelpers';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import { CardRenderingService, getCardDeckNoteForPrompt, getCardTypeSpecForPrompt } from '@/services/card';
import { hasSkipCardMarker } from '@/utils/contentMarkers';
import { logger } from '@/utils/logger';
import type { PromptManager } from '../../prompt/PromptManager';
import type { LLMService } from '../../services/LLMService';
import { extractExpectedJsonFromLlmText } from '../../utils/llmJsonExtract';

/**
 * Shared card rendering helper used by the reply pipeline and external callers.
 * Provides card JSON rendering to image segments, text-to-card conversion via a
 * secondary LLM call, card JSON detection heuristics, and readable text extraction
 * from card JSON as a fallback when rendering fails.
 */
export class CardRenderingHelper {
  private config: Config;

  constructor(
    private cardRenderingService: CardRenderingService,
    private llmService: LLMService,
    private promptManager: PromptManager,
    private hookManager: HookManager,
  ) {
    this.config = getContainer().resolve<Config>(DITokens.CONFIG);
  }

  // ---------------------------------------------------------------------------
  // Pure rendering (no context/hook side effects)
  // ---------------------------------------------------------------------------

  /** Render card JSON string → image segments. */
  async renderCardJsonToSegments(
    cardJson: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string }> {
    const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
    const base64Image = await this.cardRenderingService.renderCard(cardJson, provider);
    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: base64Image });
    return { segments: messageBuilder.build(), textForHistory: cardJson };
  }

  // ---------------------------------------------------------------------------
  // Context-integrated rendering
  // ---------------------------------------------------------------------------

  /** Set card image reply on context with standard options. */
  setCardReplyOnContext(context: HookContext, segments: MessageSegment[], cardTextForHistory: string): void {
    replaceReplyWithSegments(context, segments, 'ai', {
      isCardImage: true,
      cardTextForHistory,
    });
  }

  /**
   * Try to render card JSON and set reply on context. Returns true on success.
   * Executes onAIGenerationComplete hook on success.
   */
  async tryRenderCardReply(context: HookContext, cardJson: string, providerName?: string): Promise<boolean> {
    try {
      const result = await this.renderCardJsonToSegments(cardJson, providerName);
      this.setCardReplyOnContext(context, result.segments, result.textForHistory);
      logger.info('[CardRenderingHelper] Card image rendered and stored in reply');
      await this.hookManager.execute('onAIGenerationComplete', context);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(`[CardRenderingHelper] Card rendering failed: ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Conversion (text → card JSON via second LLM call)
  // ---------------------------------------------------------------------------

  /** Convert text → card JSON via second LLM call, then render to segments. Returns null on failure. */
  async convertAndRenderCard(
    responseText: string,
    sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    try {
      logger.info('[CardRenderingHelper] Converting response to card format via LLM');
      const cardJson = await this.convertToCardFormat(responseText, sessionId);
      logger.debug(`[CardRenderingHelper] Card format text: ${cardJson}`);
      return await this.renderCardJsonToSegments(cardJson, providerName);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown card error');
      logger.warn('[CardRenderingHelper] Card conversion/rendering failed, falling back to text:', err);
      return null;
    }
  }

  /**
   * Convert text response to card format JSON.
   * Always uses a cheap provider (doubao/deepseek), never the main reply provider.
   */
  private async convertToCardFormat(responseText: string, sessionId?: string): Promise<string> {
    const prompt = this.promptManager.render('llm.reply.convert_to_card', {
      responseText,
      cardTypeSpec: getCardTypeSpecForPrompt(),
      cardDeckNote: getCardDeckNoteForPrompt(),
    });

    const aiConfig = this.config.getAIConfig();
    const convertLlmProvider = aiConfig?.taskProviders?.convert ?? aiConfig?.defaultProviders?.llm ?? 'deepseek';
    const convertLlmModel = aiConfig?.taskProviders?.convertModel ?? '';

    const cardResponse = await this.llmService.generateLite(
      prompt,
      {
        temperature: 0.2,
        maxTokens: 4000,
        sessionId,
        model: convertLlmModel,
        jsonMode: true,
      },
      convertLlmProvider,
    );

    logger.debug(`[CardRenderingHelper] Card format conversion completed | responseLength=${cardResponse.text.length}`);

    return cardResponse.text;
  }

  // ---------------------------------------------------------------------------
  // Detection / extraction utilities
  // ---------------------------------------------------------------------------

  shouldUseCardReply(responseText: string): boolean {
    // skip if marker is detected: /skip_card
    if (hasSkipCardMarker(responseText)) return false;
    return responseText.length >= CardRenderingService.getThreshold();
  }

  /** Heuristic: does the text look like card JSON (array of card objects with "type" field)? */
  looksLikeCardJson(text: string): boolean {
    const jsonStr = extractExpectedJsonFromLlmText(text);
    if (!jsonStr) return false;
    try {
      const parsed = JSON.parse(jsonStr);
      return (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof parsed[0] === 'object' &&
        parsed[0] !== null &&
        'type' in parsed[0]
      );
    } catch {
      return false;
    }
  }

  /** Extract human-readable text from card JSON by pulling out text/content fields per card type. */
  extractReadableTextFromCardJson(text: string): string {
    try {
      const jsonStr = extractExpectedJsonFromLlmText(text);
      if (!jsonStr) return text;
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return text;

      const parts: string[] = [];
      for (const card of parsed) {
        if (typeof card !== 'object' || card === null) continue;
        if (card.title) parts.push(`## ${card.title}`);
        if (card.question) parts.push(`**${card.question}**`);
        if (card.answer) parts.push(card.answer);
        if (card.content) parts.push(card.content);
        if (card.summary) parts.push(card.summary);
        if (card.detail) parts.push(card.detail);
        if (card.text) parts.push(card.text);
        if (Array.isArray(card.items)) parts.push(card.items.map((item: unknown) => `• ${item}`).join('\n'));
        if (Array.isArray(card.steps))
          parts.push(card.steps.map((s: unknown, i: number) => `${i + 1}. ${s}`).join('\n'));
        if (Array.isArray(card.left) && Array.isArray(card.right)) {
          if (card.leftHeader) parts.push(`**${card.leftHeader}**: ${card.left.join(', ')}`);
          if (card.rightHeader) parts.push(`**${card.rightHeader}**: ${card.right.join(', ')}`);
        }
      }
      const result = parts.join('\n\n').trim();
      return result || text;
    } catch {
      return text;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (for external callers like AIService/proactive flow)
  // ---------------------------------------------------------------------------

  /**
   * Handle card reply with context: set reply on context, run hook, return boolean.
   */
  async handleCardReplyWithContext(
    responseText: string,
    sessionId: string,
    context: HookContext,
    providerName?: string,
  ): Promise<boolean> {
    if (!this.shouldUseCardReply(responseText)) {
      return false;
    }
    if (this.looksLikeCardJson(responseText)) {
      logger.info('[CardRenderingHelper] Text already looks like card JSON, rendering directly (skipping conversion)');
      const cleanJson = extractExpectedJsonFromLlmText(responseText) ?? responseText;
      const directResult = await this.renderCardJsonToSegments(cleanJson, providerName).catch(() => null);
      if (directResult) {
        this.setCardReplyOnContext(context, directResult.segments, directResult.textForHistory);
        logger.info('[CardRenderingHelper] Card image rendered and stored in reply');
        await this.hookManager.execute('onAIGenerationComplete', context);
        return true;
      }
    }
    const cardResult = await this.convertAndRenderCard(responseText, sessionId, providerName);
    if (!cardResult) {
      return false;
    }
    this.setCardReplyOnContext(context, cardResult.segments, cardResult.textForHistory);
    logger.info('[CardRenderingHelper] Card image rendered and stored in reply');
    await this.hookManager.execute('onAIGenerationComplete', context);
    return true;
  }

  /**
   * Handle card reply without context: return { segments, textForHistory } or null.
   */
  async handleCardReplyWithoutContext(
    responseText: string,
    sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    if (!this.shouldUseCardReply(responseText)) {
      return null;
    }
    if (this.looksLikeCardJson(responseText)) {
      logger.info('[CardRenderingHelper] Text already looks like card JSON, rendering directly (skipping conversion)');
      const cleanJson = extractExpectedJsonFromLlmText(responseText) ?? responseText;
      const directResult = await this.renderCardJsonToSegments(cleanJson, providerName).catch(() => null);
      if (directResult) {
        return directResult;
      }
    }
    return this.convertAndRenderCard(responseText, sessionId, providerName);
  }
}
