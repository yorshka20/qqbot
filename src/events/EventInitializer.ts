// Event Initializer - initializes EventRouter and all event handlers

import type { ConversationManager } from '@/conversation/ConversationManager';
import type { Config } from '@/core/Config';
import { logger } from '@/utils/logger';
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
    const eventDeduplicationConfig = config.getEventDeduplicationConfig();
    const eventRouter = new EventRouter(eventDeduplicationConfig);

    // Initialize event handlers
    const messageHandler = new MessageHandler(conversationManager);
    const noticeHandler = new NoticeHandler();
    const requestHandler = new RequestHandler();
    const metaEventHandler = new MetaEventHandler();

    // Register handlers to event router
    eventRouter.on('message', (event) => {
      messageHandler.handle(event);
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
