// Notice event handler

import type { MessageRecallRecorder } from '@/conversation/MessageRecallRecorder';
import { logger } from '@/utils/logger';
import type { NormalizedNoticeEvent } from '../types';

export class NoticeHandler {
  constructor(private readonly recallRecorder: MessageRecallRecorder) {}

  handle(event: NormalizedNoticeEvent): void {
    logger.info(`[Notice] ${event.noticeType}: ${JSON.stringify(event)}`);
    if (event.noticeType === 'message_recall') {
      void this.recallRecorder
        .record(event)
        .catch((err) => logger.warn('[NoticeHandler] Failed to record message recall:', err));
    }
  }
}
