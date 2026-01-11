// Message event handler

import type { NormalizedMessageEvent } from '../types';
import { logger } from '@/utils/logger';

export class MessageHandler {
  handle(event: NormalizedMessageEvent): void {
    if (event.messageType === 'group') {
      const groupName = event.groupName || 'Unknown';
      const senderName = event.sender?.card || event.sender?.nickname || event.userId.toString();
      const role = event.sender?.role || 'member';
      
      logger.info(
        `[Message] Group: ${groupName} (${event.groupId}) - ${senderName} (${event.userId}, ${role}): ${event.message}`
      );
    } else {
      logger.info(`[Message] Private from ${event.userId}: ${event.message}`);
    }
  }
}
