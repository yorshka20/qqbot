// Card Rendering Service - provides card rendering capability for LLM responses

import { type AIManager, type ConcreteLLMTarget, concreteLLMTarget, isLLMCapability } from '@qqbot/llm';
import { ConfigError, logger } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import { extractExpectedJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import { DITokens } from '@/core/DITokens';
import { CardAppearanceService } from './CardAppearanceService';
import { CardRenderer } from './CardRenderer';
import { type CardData, parseCardDeck } from './cardTypes';

/**
 * Card Rendering Service
 * Provides card rendering for LLM responses (uses puppeteer-core + system Chrome/Chromium).
 */
@singleton()
export class CardRenderingService {
  private cardRenderer: CardRenderer;
  private static readonly CARD_RENDERING_THRESHOLD = 150; // characters

  constructor(
    @inject(DITokens.AI_MANAGER) private aiManager: AIManager,
    @inject(CardAppearanceService) private appearance: CardAppearanceService,
  ) {
    this.cardRenderer = CardRenderer.getInstance();
  }

  /**
   * The attribution of a card the bot builds itself (help, dedup report, file preview): the
   * default LLM, on the model it runs when nothing names one.
   */
  defaultAttribution(): ConcreteLLMTarget {
    const target = this.aiManager.getDefaultLLM();
    if (!target) {
      throw new ConfigError('No default LLM is configured (ai.defaultProviders.llm)');
    }
    const provider = this.aiManager.getProviderForCapability('llm', target.provider);
    if (!provider || !isLLMCapability(provider)) {
      throw new ConfigError(`Default LLM provider "${target.provider}" is not available`);
    }
    return concreteLLMTarget(provider, target);
  }

  /**
   * Render pre-parsed CardData[] to a base64 image string.
   * Bypasses JSON extraction — caller is responsible for providing valid CardData[].
   * @param cards - Already-validated card data array
   * @param attribution - The provider and model shown in the card footer
   * @returns Base64 encoded image buffer
   * @throws Error if rendering fails
   */
  async renderCardData(cards: CardData[], attribution: ConcreteLLMTarget): Promise<string> {
    const imageBuffer = await this.cardRenderer.render(cards, {
      attribution,
      appearance: this.appearance.resolve(),
    });
    return imageBuffer.toString('base64');
  }

  /**
   * Render card from LLM response text
   * @param responseText - LLM response text (should be JSON card data)
   * @param attribution - The provider and model that generated the text, shown in the card footer
   * @returns Base64 encoded image buffer
   * @throws Error if JSON parsing or rendering fails
   */
  async renderCard(responseText: string, attribution: ConcreteLLMTarget): Promise<string> {
    try {
      // Expected JSON only: use dedicated JSON extractor (codeBlock, braceMatch, regex); do not mix with non-JSON strategies
      let jsonStr = extractExpectedJsonFromLlmText(responseText, { expect: 'array' }) ?? responseText;
      // When provider returns a single object (e.g. response_format.json_object), model may wrap array as {"result": [...]}
      jsonStr = this.normalizeCardDeckJson(jsonStr);
      const cards: CardData[] = parseCardDeck(jsonStr);

      logger.info('[CardRenderingService] Rendering card image');
      const imageBuffer = await this.cardRenderer.render(cards, {
        attribution,
        appearance: this.appearance.resolve(),
      });

      // Convert buffer to base64
      const base64Image = imageBuffer.toString('base64');
      logger.info('[CardRenderingService] Card image rendered successfully');

      return base64Image;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[CardRenderingService] Failed to render card:', err);
      throw new Error(`Failed to render card: ${err.message}`);
    }
  }

  /**
   * Normalize extracted JSON to a string that parseCardDeck accepts (root = array).
   * If the LLM returned a single object with key "result" (array), unwrap to that array JSON string.
   */
  private normalizeCardDeckJson(jsonStr: string): string {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (Array.isArray(parsed)) {
        return jsonStr.trim();
      }
      if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.result)) {
        return JSON.stringify(parsed.result);
      }
    } catch {
      // Not valid JSON or not the expected shape; fall through and return as-is for parseCardDeck to throw
    }
    return jsonStr;
  }

  /**
   * Get card rendering threshold
   */
  static getThreshold(): number {
    return CardRenderingService.CARD_RENDERING_THRESHOLD;
  }
}
