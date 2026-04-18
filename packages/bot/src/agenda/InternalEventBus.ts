// Internal event bus for system events (group member join, keyword match, nudge, etc.)
// Lightweight typed EventEmitter; any module can publish, AgendaService subscribes.

import { EventEmitter } from 'node:events';
import type { AgendaSystemEvent } from './types';

/**
 * InternalEventBus
 *
 * Decouples event producers (NoticeHandler, MessageHandler, etc.) from
 * AgendaService's event-driven agenda items. Producers call `publish(event)`;
 * AgendaService subscribes via `subscribe(type, handler)`.
 *
 * Singleton usage: instantiated by AgendaInitializer, registered to DI container,
 * then resolved by any module that needs to publish or subscribe.
 */
export class InternalEventBus extends EventEmitter {
  /**
   * Publish a system event. All subscribers for event.type will be notified.
   */
  publish(event: AgendaSystemEvent): void {
    this.emit(event.type, event);
  }

  /**
   * Subscribe to a specific event type.
   */
  subscribe(type: string, handler: (event: AgendaSystemEvent) => void): void {
    this.on(type, handler);
  }

  /**
   * Unsubscribe a previously registered handler.
   */
  unsubscribe(type: string, handler: (event: AgendaSystemEvent) => void): void {
    this.off(type, handler);
  }
}
