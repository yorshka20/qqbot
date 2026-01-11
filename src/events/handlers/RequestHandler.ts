// Request event handler

import type { NormalizedRequestEvent } from '../types';
import { logger } from '@/utils/logger';

export class RequestHandler {
  handle(event: NormalizedRequestEvent): void {
    logger.debug(`[Request] ${event.requestType}:`, event);
  }
}
