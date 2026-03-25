// Response dispatch stage — card/text dispatch + onAIGenerationComplete hook.

import { replaceReply, setReplyWithSegments } from '@/context/HookContextHelpers';
import type { HookManager } from '@/hooks/HookManager';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { containsTextToolCalls, stripTextToolCalls } from '../../utils/dsmlParser';
import { extractExpectedJsonFromLlmText } from '../../utils/llmJsonExtract';
import type { CardRenderingHelper } from '../helpers/CardRenderingHelper';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 8: response dispatch.
 * Routes the LLM response to the appropriate output path:
 * 1. Direct card — LLM produced card JSON via `format_as_card` tool → render image
 * 2. Conversion card — long text exceeds threshold → secondary LLM converts to card JSON → render
 * 3. Plain text — default path with tool-call artifact stripping
 * Fires `onAIGenerationComplete` hook and appends task result images when present.
 */
export class ResponseDispatchStage implements ReplyStage {
  readonly name = 'response-dispatch';

  constructor(
    private cardHelper: CardRenderingHelper,
    private hookManager: HookManager,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const { hookContext } = ctx;
    const usedCardFormat = hookContext.metadata.get('usedCardFormat') === true;

    // Path 1: LLM already produced card JSON via format_as_card tool
    if (usedCardFormat) {
      const success = await this.cardHelper.tryRenderCardReply(hookContext, ctx.responseText, ctx.actualProvider);
      if (success) {
        this.appendToolResultImages(ctx);
        return;
      }
      logger.warn('[ResponseDispatchStage] Direct card JSON from LLM failed to render, attempting JSON extraction');
      const cleanJson = extractExpectedJsonFromLlmText(ctx.responseText);
      if (cleanJson) {
        const retrySuccess = await this.cardHelper.tryRenderCardReply(hookContext, cleanJson, ctx.actualProvider);
        if (retrySuccess) {
          this.appendToolResultImages(ctx);
          return;
        }
      }
      // Card rendering truly failed — extract readable text as last resort
      logger.warn('[ResponseDispatchStage] Card rendering failed completely, extracting readable text');
      const readableText = this.cardHelper.extractReadableTextFromCardJson(ctx.responseText);
      await this.hookManager.execute('onAIGenerationComplete', hookContext);
      replaceReply(hookContext, readableText, 'ai');
      return;
    }

    // Skip card rendering when the response contains a command (e.g. /nai-plus ...)
    // so the command text is sent as-is and can be processed by the command system.
    const containsCommand = MessageUtils.isCommand(ctx.responseText);

    // Path 2: Long text → convert to card via second LLM call
    if (!containsCommand && this.cardHelper.shouldUseCardReply(ctx.responseText)) {
      // If text is already card JSON, render directly
      if (this.cardHelper.looksLikeCardJson(ctx.responseText)) {
        logger.info(
          '[ResponseDispatchStage] Text already looks like card JSON, rendering directly (skipping conversion)',
        );
        const cleanJson = extractExpectedJsonFromLlmText(ctx.responseText) ?? ctx.responseText;
        const success = await this.cardHelper.tryRenderCardReply(hookContext, cleanJson, ctx.actualProvider);
        if (success) {
          this.appendToolResultImages(ctx);
          return;
        }
      }
      const cardResult = await this.cardHelper.convertAndRenderCard(
        ctx.responseText,
        ctx.sessionId,
        ctx.actualProvider,
      );
      if (cardResult) {
        this.cardHelper.setCardReplyOnContext(hookContext, cardResult.segments, cardResult.textForHistory);
        await this.hookManager.execute('onAIGenerationComplete', hookContext);
        this.appendToolResultImages(ctx);
        return;
      }
    }

    // Path 3: Plain text
    await this.hookManager.execute('onAIGenerationComplete', hookContext);
    let finalText = ctx.responseText;
    if (containsTextToolCalls(finalText)) {
      logger.warn('[ResponseDispatchStage] Stripping leaked text-based tool call blocks from final reply');
      finalText = stripTextToolCalls(finalText);
    }
    // Safety net: if text looks like card JSON
    if (this.cardHelper.looksLikeCardJson(finalText)) {
      logger.warn('[ResponseDispatchStage] Plain text path received card JSON, extracting readable text');
      finalText = this.cardHelper.extractReadableTextFromCardJson(finalText);
    }
    replaceReply(hookContext, finalText, 'ai');
  }

  /** Append task result images to context.reply (text + images). */
  private appendToolResultImages(ctx: ReplyPipelineContext): void {
    if (ctx.taskResultImages.length === 0) return;
    const imageSegments = ctx.taskResultImages.map((base64) => ({
      type: 'image' as const,
      data: { uri: `base64://${base64}`, sub_type: 'normal' as const, summary: '' },
    }));
    setReplyWithSegments(ctx.hookContext, imageSegments, 'ai', {
      isCardImage: true,
    });
  }
}
