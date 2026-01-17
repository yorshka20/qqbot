// Notice event handler

import { logger } from '@/utils/logger';
import type { NormalizedNoticeEvent } from '../types';

export class NoticeHandler {
  handle(event: NormalizedNoticeEvent): void {
    logger.debug(`[Notice] ${event.noticeType}: ${JSON.stringify(event)}`);
  }
}
