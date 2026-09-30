import { inject, singleton } from 'tsyringe';
import { stripLeakedToolCalls } from '@/ai/utils/dsmlParser';
import { extractTextFromSegments } from '@/ai/utils/imageUtils';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { HookContext } from '@/hooks/types';
import { expandFaceMarkers } from '@/message/qqFace';
import { parseDeliveryMarkers } from '@/utils/contentMarkers';
import { logger } from '@/utils/logger';

/**
 * Sends model-written text into the conversation a hook context came from, immediately,
 * outside the reply pipeline's PREPARE / SEND stages. It applies the same text cleanup
 * PREPARE gives a reply (leaked tool-call blocks stripped, `[表情:名字]` expanded) and
 * writes the delivered message to that session's history, because a send that bypasses
 * SendSystem never reaches `onMessageSent` — without the write, the next turn's LLM would
 * see a conversation missing its own words.
 *
 * Delivery markers are dropped: this path always sends text directly, so they have nothing
 * to act on, but they must not reach the chat as literal text.
 */
@singleton()
export class ConversationMessageSender {
  constructor(
    @inject(MessageAPI) private readonly messageAPI: MessageAPI,
    @inject(ConversationHistoryService) private readonly historyService: ConversationHistoryService,
  ) {}

  /**
   * Returns the delivered text in canonical form (faces as `[表情:名字]`), or null when
   * nothing sendable is left after cleanup. Throws when the send itself fails.
   * `viaTool` marks the history row with the tool that sent it.
   */
  async sendText(context: HookContext, text: string, viaTool?: string): Promise<string | null> {
    const { segments, unresolved } = expandFaceMarkers(parseDeliveryMarkers(stripLeakedToolCalls(text)).text);
    if (unresolved.length > 0) {
      logger.warn(`[ConversationMessageSender] Dropped unknown face marker(s): ${unresolved.join(', ')}`);
    }
    const delivered = extractTextFromSegments(segments);
    if (!delivered) {
      return null;
    }

    // The target comes from the conversation context, never from model output — model
    // text must not be able to reach an arbitrary chat.
    const sendResult = await this.messageAPI.sendFromContext(segments, context.message);
    await this.persist(context, delivered, sendResult.message_seq, viaTool);
    return delivered;
  }

  /** History is best-effort: the message already reached the chat (appendBotMessageToSession catches internally). */
  private async persist(context: HookContext, content: string, messageSeq?: number, viaTool?: string): Promise<void> {
    const message = context.message;
    const isGroup = message.messageType === 'group';
    const targetId = isGroup ? message.groupId : message.userId;
    if (targetId == null) {
      return;
    }
    const botSelfId = Number(context.metadata.get('botSelfId'));
    await this.historyService.appendBotMessageToSession(
      { sessionType: isGroup ? 'group' : 'user', targetId },
      content,
      message.protocol,
      {
        botUserId: Number.isNaN(botSelfId) ? 0 : botSelfId,
        messageSeq,
        viaTool,
      },
    );
  }
}
