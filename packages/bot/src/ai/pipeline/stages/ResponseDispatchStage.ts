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
 *
 * Path 1: send_card executor already rendered and queued the card (cardSent=true)
 * Path 1.5: send_card was called but rendering failed (cardSendFailedReason set) → fall through to Path 2
 * Path 2a: Long + markdown-formatted text → render as markdown card image.
 * Path 2b: Long + plain prose → force sendAsForward (override group config) and ship
 *          the original prose. Long plain text shouldn't be stuffed into a card —
 *          that's what forward messages are for. Falls through to Path 3 for the
 *          actual reply assembly.
 * Path 3: Plain text reply — uses ctx.responseText (never outputs failed/repaired JSON).
 *         ReplyPrepareSystem reads explicitSendAsForward set in Path 2b.
 *
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
    const cardSent = hookContext.metadata.get('cardSent') === true;
    const cardSendFailedReason = hookContext.metadata.get('cardSendFailedReason') as string | undefined;

    // Path 1: send_card executor already rendered and queued the card
    if (cardSent) {
      this.appendToolResultImages(ctx);
      return;
    }

    // Path 1.5: send_card was called but rendering failed → fall through to Path 2
    if (cardSendFailedReason) {
      logger.warn(
        `[ResponseDispatchStage] send_card 渲染失败 (${cardSendFailedReason})，fall through 到 Path 2 markdown render`,
      );
      // Do not return — fall through to Path 2
    }

    // Skip card rendering when the response contains a command (e.g. /nai-plus ...)
    const containsCommand = MessageUtils.isCommand(ctx.responseText);

    // Path 2: Long text. Only markdown-formatted content gets card-rendered;
    // plain prose is forwarded instead so we don't stuff every long reply into
    // a card image. The send_card tool is the model's lever for "I want a
    // structured card"; not using it means "ship as prose".
    if (!containsCommand && this.cardHelper.shouldUseCardReply(ctx.responseText)) {
      if (this.cardHelper.looksLikeMarkdown(ctx.responseText)) {
        // Path 2a: markdown → card
        const mdResult = await this.cardHelper
          .renderMarkdownDirect(ctx.responseText, ctx.actualProvider)
          .catch(() => null);
        if (mdResult) {
          this.cardHelper.setCardReplyOnContext(hookContext, mdResult.segments, mdResult.textForHistory);
          await this.hookManager.execute('onAIGenerationComplete', hookContext);
          this.appendToolResultImages(ctx);
          return;
        }
        logger.warn('[ResponseDispatchStage] Path 2a markdown 渲染失败，fallback 到 Path 2b forward');
      }
      // Path 2b: long plain prose → force forward (overrides groupUseForwardMsg=false);
      // fall through to Path 3 which assembles the final text reply. Forward keeps
      // long replies from spamming the group while preserving the original prose.
      hookContext.metadata.set('explicitSendAsForward', true);
      logger.info('[ResponseDispatchStage] Path 2b: long plain prose → explicitSendAsForward=true');
    }

    // Path 3: plain prose — always use ctx.responseText (original LLM prose), never output failed JSON
    await this.hookManager.execute('onAIGenerationComplete', hookContext);
    let finalText = ctx.responseText;
    if (containsTextToolCalls(finalText)) {
      logger.warn('[ResponseDispatchStage] Stripping leaked text-based tool call blocks from final reply');
      finalText = stripTextToolCalls(finalText);
    }
    // Hard constraint: never send raw card-deck-style JSON to user. If responseText
    // *looks* like a card JSON array (LLM output JSON-as-text instead of using send_card),
    // degrade to readable markdown extracted from the deck.
    if (this.looksLikeCardDeckJson(finalText)) {
      logger.warn('[ResponseDispatchStage] Path 3 received card-deck-like JSON; extracting readable text');
      finalText = this.cardHelper.extractReadableTextFromCardJson(finalText);
    }
    replaceReply(hookContext, finalText, 'ai');
  }

  /**
   * True when text contains a parsable JSON array whose first element looks like a card
   * (object with a `type` field). Used as a final safety net before sending plain prose
   * — we must never emit raw card JSON to the user.
   */
  private looksLikeCardDeckJson(text: string): boolean {
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
