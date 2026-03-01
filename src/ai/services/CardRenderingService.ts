// Card Rendering Service - provides card rendering capability for LLM responses

import { type ExtractStrategy, extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';
import type { AIManager } from '../AIManager';
import type { AIProvider } from '../base/AIProvider';
import { CardRenderer } from '../utils/CardRenderer';
import { type CardData, parseCardData } from '../utils/cardTypes';

/** Card format prompt returns JSON; may be in code block or raw. */
const CARD_JSON_EXTRACT_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'regex'];

/**
 * Card Rendering Service
 * Provides card rendering for LLM responses (uses puppeteer-core + system Chrome/Chromium).
 */
export class CardRenderingService {
  private cardRenderer: CardRenderer;
  private static readonly CARD_RENDERING_THRESHOLD = 300; // characters

  constructor(private aiManager: AIManager) {
    this.cardRenderer = CardRenderer.getInstance();
  }

  /**
   * Check if provider is local (ollama)
   */
  private isLocalProvider(provider: AIProvider | null): boolean {
    return provider !== null && provider.name === 'ollama';
  }

  /**
   * Get current LLM provider
   */
  private getCurrentProvider(sessionId?: string, providerName?: string): AIProvider | null {
    if (providerName) {
      return this.aiManager.getProviderForCapability('llm', providerName) || null;
    }

    // Get default provider
    return this.aiManager.getDefaultProvider('llm');
  }

  /**
   * Check if card rendering should be used
   * Conditions:
   * 1. Provider is not local (not ollama)
   * 2. Response length >= threshold
   * 3. Response is valid JSON card data
   */
  shouldUseCardRendering(responseText: string, sessionId?: string, providerName?: string): boolean {
    // Check length threshold
    if (responseText.length < CardRenderingService.CARD_RENDERING_THRESHOLD) {
      return false;
    }

    // Check if provider is local
    const provider = this.getCurrentProvider(sessionId, providerName);
    if (this.isLocalProvider(provider)) {
      return false;
    }

    // Check if response is valid JSON card data (extract JSON from LLM text if wrapped in markdown/prose)
    const jsonStr = extractJsonFromLlmText(responseText, { strategies: CARD_JSON_EXTRACT_STRATEGIES }) ?? responseText;
    try {
      parseCardData(jsonStr);
      return true;
    } catch {
      // Not valid JSON card data
      return false;
    }
  }

  /**
   * Render card from LLM response text
   * @param responseText - LLM response text (should be JSON card data)
   * @returns Base64 encoded image buffer
   * @throws Error if JSON parsing or rendering fails
   */
  async renderCard(responseText: string): Promise<string> {
    try {
      // Extract JSON from LLM text if wrapped in markdown/prose, then parse card data
      const jsonStr =
        extractJsonFromLlmText(responseText, { strategies: CARD_JSON_EXTRACT_STRATEGIES }) ?? responseText;
      const cardData: CardData = parseCardData(jsonStr);

      // Render card to image
      logger.info('[CardRenderingService] Rendering card image');
      const imageBuffer = await this.cardRenderer.render(cardData);

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
   * Check if provider should use card format prompt
   * @param sessionId - Session ID for provider selection
   * @param providerName - Optional provider name
   * @returns true if card format prompt should be used
   */
  shouldUseCardFormatPrompt(sessionId?: string, providerName?: string): boolean {
    const provider = this.getCurrentProvider(sessionId, providerName);
    return !this.isLocalProvider(provider);
  }

  /**
   * Get card rendering threshold
   */
  static getThreshold(): number {
    return CardRenderingService.CARD_RENDERING_THRESHOLD;
  }
}
