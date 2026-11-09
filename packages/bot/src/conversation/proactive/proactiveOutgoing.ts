import type { ConcreteLLMTarget } from '@qqbot/llm';
import type { ProactiveReply } from '@/ai/services/ProactiveReplyGenerationService';
import { type RenderedCard, withTrailingText } from '@/context/HookContextHelpers';
import type { MessageSegment } from '@/message/types';
import { parseSubtextTags } from '@/persona/prompt/subtextTagParser';
import { parseDeliveryMarkers } from '@/utils/contentMarkers';

export interface ProactiveOutgoing {
  message: string | MessageSegment[];
  historyText: string;
  subtext?: string;
  replyTags?: string[];
}

/**
 * Resolve what a proactive reply sends and what history records for it; null when there is nothing
 * to send. A card queued by `send_card` is sent with the final text appended after it (the delivery
 * contract promises final text is always sent); otherwise the final text goes through
 * `renderMaybeCard` unless the model wrote `/skip_card`.
 */
export async function resolveProactiveOutgoing(
  reply: ProactiveReply,
  renderMaybeCard: (text: string, servedBy: ConcreteLLMTarget) => Promise<RenderedCard | null>,
): Promise<ProactiveOutgoing | null> {
  const parsed = parseSubtextTags(reply.text);
  const { text, skipCard } = parseDeliveryMarkers(parsed.visible);
  const tags = {
    ...(parsed.subtext !== undefined ? { subtext: parsed.subtext } : {}),
    ...(parsed.replyTags !== undefined ? { replyTags: parsed.replyTags } : {}),
  };

  if (reply.card) {
    const delivered = withTrailingText(reply.card, text);
    return { message: delivered.segments, historyText: delivered.textForHistory, ...tags };
  }
  if (!text) {
    return null;
  }
  const rendered = skipCard || !reply.servedBy ? null : await renderMaybeCard(text, reply.servedBy);
  return rendered
    ? { message: rendered.segments, historyText: rendered.textForHistory, ...tags }
    : { message: text, historyText: text, ...tags };
}
