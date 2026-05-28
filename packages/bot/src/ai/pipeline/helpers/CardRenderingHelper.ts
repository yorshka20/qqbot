// Card rendering helper — shared card rendering, detection, and extraction logic.

import { replaceReplyWithSegments } from '@/context/HookContextHelpers';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import { CardRenderingService } from '@/services/card';
import type { CardData } from '@/services/card/cardTypes';
import { hasSkipCardMarker } from '@/utils/contentMarkers';
import { logger } from '@/utils/logger';
import { extractExpectedJsonFromLlmText } from '../../utils/llmJsonExtract';

/**
 * Shared card rendering helper used by the reply pipeline and external callers.
 * Renders card JSON or markdown to image segments, detects card-JSON shaped
 * text, and extracts human-readable fallback text from card JSON when rendering
 * fails. There is intentionally no "convert plain text to card JSON via LLM"
 * path — the model is given the `send_card` tool; if it chooses not to use it,
 * the response is rendered as a markdown card (plain prose is valid markdown).
 */
export class CardRenderingHelper {
  constructor(
    private cardRenderingService: CardRenderingService,
    private hookManager: HookManager,
  ) {}

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

  /** Render pre-parsed CardData[] → image segments. Skips JSON extraction entirely. */
  async renderParsedCards(
    cards: CardData[],
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string }> {
    const provider = providerName ?? this.cardRenderingService.getDefaultProviderName();
    const base64Image = await this.cardRenderingService.renderCardData(cards, provider);
    const messageBuilder = new MessageBuilder();
    messageBuilder.image({ data: base64Image });
    return { segments: messageBuilder.build(), textForHistory: JSON.stringify(cards) };
  }

  /**
   * Direct markdown → image card. Wraps the raw markdown in a single `markdown`
   * card so cardTemplates can parse + render it without going through the
   * card-format LLM. `textForHistory` is the original markdown so subsequent
   * turns see the model's actual prose, not a JSON wrapper.
   */
  async renderMarkdownDirect(
    content: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string }> {
    const card: CardData = { type: 'markdown', content };
    const result = await this.renderParsedCards([card], providerName);
    return { segments: result.segments, textForHistory: content };
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
  // Detection / extraction utilities
  // ---------------------------------------------------------------------------

  shouldUseCardReply(responseText: string): boolean {
    // skip if marker is detected: /skip_card
    if (hasSkipCardMarker(responseText)) return false;
    return responseText.length >= CardRenderingService.getThreshold();
  }

  /**
   * Heuristic: does the text look like it's already markdown-formatted?
   * Triggers on any "strong" markdown signal — heading, code fence, table row, blockquote.
   * Weak signals (bold, list, inline code) are intentionally ignored to avoid false
   * positives on conversational prose that happens to use a single `**word**` or bullet.
   *
   * Why this matters: long plain prose should ship as a forward message (multi-bubble
   * wrapper) rather than getting stuffed into a markdown card — cards exist to render
   * structured content, not to hide every long reply. ResponseDispatchStage gates the
   * markdown-card branch on this check.
   */
  looksLikeMarkdown(text: string): boolean {
    if (/^#{1,6}\s+\S/m.test(text)) return true; // ATX heading
    if (/^```/m.test(text)) return true; // fenced code block
    if (/^\s*\|.+\|.+\|\s*$/m.test(text)) return true; // table row (3+ cells)
    if (/^>\s+\S/m.test(text)) return true; // blockquote
    return false;
  }

  /** Heuristic: does the text look like card JSON (array of card objects with "type" field)? */
  looksLikeCardJson(text: string): boolean {
    const jsonStr = extractExpectedJsonFromLlmText(text, { expect: 'array' });
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
      const jsonStr = extractExpectedJsonFromLlmText(text, { expect: 'array' });
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
   * Handle card reply with context: set reply on context if the text is card-able,
   * otherwise return false so the caller can ship the original prose as a forward
   * or direct text message.
   *
   * Two card-eligible shapes:
   *   1. Text parses as card-deck JSON → render JSON.
   *   2. Text looks markdown-formatted → render markdown card.
   * Plain prose intentionally returns false — long prose belongs in a forward
   * message, not a card image.
   */
  async handleCardReplyWithContext(
    responseText: string,
    _sessionId: string,
    context: HookContext,
    providerName?: string,
  ): Promise<boolean> {
    if (!this.shouldUseCardReply(responseText)) return false;
    if (this.looksLikeCardJson(responseText)) {
      const cleanJson = extractExpectedJsonFromLlmText(responseText, { expect: 'array' }) ?? responseText;
      const directResult = await this.renderCardJsonToSegments(cleanJson, providerName).catch(() => null);
      if (directResult) {
        this.setCardReplyOnContext(context, directResult.segments, directResult.textForHistory);
        await this.hookManager.execute('onAIGenerationComplete', context);
        return true;
      }
    }
    if (this.looksLikeMarkdown(responseText)) {
      const mdResult = await this.renderMarkdownDirect(responseText, providerName).catch(() => null);
      if (mdResult) {
        this.setCardReplyOnContext(context, mdResult.segments, mdResult.textForHistory);
        await this.hookManager.execute('onAIGenerationComplete', context);
        return true;
      }
    }
    return false;
  }

  /**
   * Handle card reply without context: return { segments, textForHistory } when the
   * text is card-able, null otherwise. Same eligibility rules as
   * `handleCardReplyWithContext` — plain prose → null so caller ships it directly.
   */
  async handleCardReplyWithoutContext(
    responseText: string,
    _sessionId: string,
    providerName?: string,
  ): Promise<{ segments: MessageSegment[]; textForHistory: string } | null> {
    if (!this.shouldUseCardReply(responseText)) return null;
    if (this.looksLikeCardJson(responseText)) {
      const cleanJson = extractExpectedJsonFromLlmText(responseText, { expect: 'array' }) ?? responseText;
      const directResult = await this.renderCardJsonToSegments(cleanJson, providerName).catch(() => null);
      if (directResult) return directResult;
    }
    if (this.looksLikeMarkdown(responseText)) {
      return this.renderMarkdownDirect(responseText, providerName).catch(() => null);
    }
    return null;
  }
}
