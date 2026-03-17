// Card Rendering Service - provides card rendering capability for LLM responses

import type { AIManager } from '@/ai/AIManager';
import { extractExpectedJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';
import { CardRenderer } from './CardRenderer';
import { type CardData, parseCardDeck } from './cardTypes';

/**
 * Card Rendering Service
 * Provides card rendering for LLM responses (uses puppeteer-core + system Chrome/Chromium).
 */
export class CardRenderingService {
  private cardRenderer: CardRenderer;
  private static readonly CARD_RENDERING_THRESHOLD = 150; // characters

  constructor(private aiManager: AIManager) {
    this.cardRenderer = CardRenderer.getInstance();
  }

  /**
   * Get default LLM provider name for card footer when no specific provider is in context (e.g. help command, system cards).
   */
  getDefaultProviderName(): string {
    const provider = this.aiManager.getDefaultProvider('llm');
    return provider?.name ?? 'default';
  }

  /**
   * Render card from LLM response text
   * @param responseText - LLM response text (should be JSON card data)
   * @param providerName - Provider name (e.g. doubao, claude, deepseek) shown in card footer; required on all paths
   * @returns Base64 encoded image buffer
   * @throws Error if JSON parsing or rendering fails
   */
  async renderCard(responseText: string, providerName: string): Promise<string> {
    try {
      // Expected JSON only: use dedicated JSON extractor (codeBlock, braceMatch, regex); do not mix with non-JSON strategies
      let jsonStr = extractExpectedJsonFromLlmText(responseText) ?? responseText;
      // When provider returns a single object (e.g. response_format.json_object), model may wrap array as {"result": [...]}
      jsonStr = this.normalizeCardDeckJson(jsonStr);
      const cards: CardData[] = parseCardDeck(jsonStr);

      // Render card(s) to image (provider required for footer on all paths)
      logger.info('[CardRenderingService] Rendering card image');
      const imageBuffer = await this.cardRenderer.render(cards, { provider: providerName });

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
