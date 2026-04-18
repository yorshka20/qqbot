// FetchProgressNotifier implementation that sends "正在查询：\n- title1\n- title2" via MessageAPI.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';

export interface FetchProgressNotifier {
  onFetchingUrls(titles: string[]): void;
  setMessageEvent(event: NormalizedMessageEvent): void;
}

/**
 * Sends fetch progress to the current message context as one message listing all titles (e.g. "正在查询：\n- xxx\n- xxx2").
 * Singleton: all instances refer to the same underlying instance (constructors after the first return the same object).
 */
export class MessageSendFetchProgressNotifier implements FetchProgressNotifier {
  private static instance: MessageSendFetchProgressNotifier | null = null;
  private currentMessageEvent: NormalizedMessageEvent | null = null;
  private messageAPI: MessageAPI;

  constructor(messageAPI: MessageAPI) {
    this.messageAPI = messageAPI;
    if (MessageSendFetchProgressNotifier.instance) {
      return;
    }
    MessageSendFetchProgressNotifier.instance = this;
  }

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
