// Notice event handler

import type { NormalizedNoticeEvent } from '../types';
import { logger } from '@/utils/logger';

export class NoticeHandler {
  handle(event: NormalizedNoticeEvent): void {
    logger.debug(`[Notice] ${event.noticeType}:`, event);
  }
}
