// Routes protocol events to appropriate handlers

import { logger } from '@/utils/logger';
import { EventEmitter } from 'events';
import type { DeduplicationConfig } from './EventDeduplicator';
import { EventDeduplicator } from './EventDeduplicator';
import type { EventHandler, NormalizedEvent } from './types';

export interface EventRouterEvents {
  message: (event: NormalizedEvent & { type: 'message' }) => void;
  notice: (event: NormalizedEvent & { type: 'notice' }) => void;
  request: (event: NormalizedEvent & { type: 'request' }) => void;
  meta_event: (event: NormalizedEvent & { type: 'meta_event' }) => void;
  '*': (event: NormalizedEvent) => void;
}

export declare interface EventRouter {
  on<U extends keyof EventRouterEvents>(
    event: U,
    listener: EventRouterEvents[U],
  ): this;
  emit<U extends keyof EventRouterEvents>(
    event: U,
    ...args: Parameters<EventRouterEvents[U]>
  ): boolean;
}

export class EventRouter extends EventEmitter {
  private deduplicator: EventDeduplicator;
  private handlers = new Map<string, Set<EventHandler>>();

  constructor(deduplicationConfig: DeduplicationConfig) {
    super();
    this.deduplicator = new EventDeduplicator(deduplicationConfig);
  }

  routeEvent(event: NormalizedEvent): void {
    // Check deduplication
    if (!this.deduplicator.shouldProcess(event)) {
      return;
    }

    logger.debug(
      `[EventRouter] Routing event: ${event.type} from ${event.protocol}`,
    );

    // Emit typed event
    switch (event.type) {
      case 'message':
        this.emit('message', event as NormalizedEvent & { type: 'message' });
        break;
      case 'notice':
        this.emit('notice', event as NormalizedEvent & { type: 'notice' });
        break;
      case 'request':
        this.emit('request', event as NormalizedEvent & { type: 'request' });
        break;
      case 'meta_event':
        this.emit(
          'meta_event',
          event as NormalizedEvent & { type: 'meta_event' },
        );
        break;
    }

    // Emit wildcard event
    this.emit('*', event);
  }

  onEvent<T extends NormalizedEvent>(
    eventType: string,
    handler: EventHandler<T>,
  ): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as EventHandler);

    // Also subscribe to the event emitter
    this.on(eventType as any, handler as any);
  }

  offEvent<T extends NormalizedEvent>(
    eventType: string,
    handler: EventHandler<T>,
  ): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler as EventHandler);
      this.off(eventType as any, handler as any);
    }
  }

  destroy(): void {
    this.deduplicator.destroy();
    this.handlers.clear();
    this.removeAllListeners();
  }
}
