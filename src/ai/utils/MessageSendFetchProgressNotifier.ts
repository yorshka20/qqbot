// FetchProgressNotifier implementation that sends "正在查询：\n- title1\n- title2" via MessageAPI.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { NormalizedMessageEvent } from '@/events/types';
import type { FetchProgressNotifier } from '@/retrieval/fetch';
import { logger } from '@/utils/logger';

/**
 * Sends fetch progress to the current message context as one message listing all titles (e.g. "正在查询：\n- xxx\n- xxx2").
 * Single instance per owner; call setMessageEvent() before each retrieve/fetch flow so messages go to the right chat.
 */
export class MessageSendFetchProgressNotifier implements FetchProgressNotifier {
  private currentMessageEvent: NormalizedMessageEvent | null = null;

  constructor(private readonly messageAPI: MessageAPI) {}

  /** Set the message event (target chat) for the next onFetchingUrls call. */
  setMessageEvent(event: NormalizedMessageEvent): void {
    this.currentMessageEvent = event;
  }

  onFetchingUrls(titles: string[]): void {
    if (!this.currentMessageEvent || titles.length === 0) {
      return;
    }
    const lines = titles.map((t) => `- ${t}`);
    const text = `正在查询：\n${lines.join('\n')}`;
    this.messageAPI.sendFromContext(text, this.currentMessageEvent, 5000).catch((err: unknown) => {
      logger.debug(
        `[MessageSendFetchProgressNotifier] Failed to send fetch hint: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
