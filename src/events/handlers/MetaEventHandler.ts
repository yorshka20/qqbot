// Meta event handler

import type { NormalizedMetaEvent } from '../types';
import { logger } from '@/utils/logger';

export class MetaEventHandler {
  handle(event: NormalizedMetaEvent): void {
    if (event.metaEventType === 'heartbeat') {
      // Heartbeat events can be ignored or logged at debug level
      logger.debug('[MetaEvent] Heartbeat received');
    } else {
      logger.debug(`[MetaEvent] ${event.metaEventType}:`, event);
    }
  }
}
