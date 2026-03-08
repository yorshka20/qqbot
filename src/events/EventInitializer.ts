// Event Initializer - initializes EventRouter and all event handlers

import { enterMessageContext } from '@/context/MessageContextStorage';
import type { ConversationManager } from '@/conversation/ConversationManager';
import type { Config } from '@/core/config';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { getLogColorForKey, getLogTag } from '@/utils/messageLogContext';
import { EventRouter } from './EventRouter';
import { MessageHandler } from './handlers/MessageHandler';
import { MetaEventHandler } from './handlers/MetaEventHandler';
import { NoticeHandler } from './handlers/NoticeHandler';
import { RequestHandler } from './handlers/RequestHandler';

export interface EventSystem {
  eventRouter: EventRouter;
}

/**
 * Event Initializer
 * Initializes EventRouter and registers all event handlers
 */
export class EventInitializer {
  /**
   * Initialize event system with all handlers
   * @param config - Bot configuration
   * @param conversationManager - Conversation manager (required for MessageHandler)
   * @returns Initialized event system
   */
  static initialize(config: Config, conversationManager: ConversationManager): EventSystem {
    logger.info('[EventInitializer] Starting initialization...');

    // Initialize event router
    const eventConfig = config.getEventConfig();
    const eventDeduplicationConfig = eventConfig.deduplication;
    const eventRouter = new EventRouter(eventDeduplicationConfig);

    // Initialize event handlers
    const messageHandler = new MessageHandler(conversationManager);
    const noticeHandler = new NoticeHandler();
    const requestHandler = new RequestHandler();
    const metaEventHandler = new MetaEventHandler();

    // Register handlers to event router. Enter message context so logger can color by message (from first log in MessageHandler through pipeline).
    eventRouter.on('message', async (event: NormalizedMessageEvent) => {
      const messageId = String(event.id ?? event.messageId ?? 'unknown');
      const logTag = getLogTag(messageId);
      const logColor = getLogColorForKey(messageId);
      await enterMessageContext(messageId, { message: event, logTag, logColor }, () => messageHandler.handle(event));
    });

    eventRouter.on('notice', (event) => {
      noticeHandler.handle(event);
    });

    eventRouter.on('request', (event) => {
      requestHandler.handle(event);
    });

    eventRouter.on('meta_event', (event) => {
      metaEventHandler.handle(event);
    });

    logger.info('[EventInitializer] Event handlers registered to EventRouter');

    return {
      eventRouter,
    };
  }
}
