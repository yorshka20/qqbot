// Request event handler

import { logger } from '@/utils/logger';
import type { NormalizedRequestEvent } from '../types';

export class RequestHandler {
  handle(event: NormalizedRequestEvent): void {
    logger.debug(`[Request] ${event.requestType}:`, event);
  }
}
