// Card Rendering Service - provides card rendering capability for LLM responses

import type { AIManager } from '@/ai/AIManager';
import type { AIProvider } from '@/ai/base/AIProvider';
import { type ExtractStrategy, extractJsonFromLlmText } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';
import { CardRenderer } from './CardRenderer';
import { type CardData, parseCardDeck } from './cardTypes';

/** Card format prompt returns JSON; may be in code block, prose, or raw. braceMatch helps when LLM wraps JSON in text. */
const CARD_JSON_EXTRACT_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'braceMatch', 'regex'];

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
   * Check if provider is local (ollama)
   */
  private isLocalProvider(provider: AIProvider | null): boolean {
    return provider !== null && provider.name === 'ollama';
  }

  /**
   * Get current LLM provider
   */
  private getCurrentProvider(_sessionId?: string, providerName?: string): AIProvider | null {
    if (providerName) {
      return this.aiManager.getProviderForCapability('llm', providerName) || null;
    }

    // Get default provider
    return this.aiManager.getDefaultProvider('llm');
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
      // Extract JSON from LLM text if wrapped in markdown/prose, then parse card deck (single or multiple cards)
      const jsonStr =
        extractJsonFromLlmText(responseText, { strategies: CARD_JSON_EXTRACT_STRATEGIES }) ?? responseText;
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
