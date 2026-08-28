// Internal event bus for system events (group member join, keyword match, nudge, etc.)
// Lightweight typed EventEmitter; any module can publish, AgendaService subscribes.

import { EventEmitter } from 'node:events';
import { DEFAULT_AGENDA_LLM_LIMITS } from '@/core/config/types/agenda';
import type { AgendaSystemEvent } from './types';

/**
 * Headroom over the LLM item budget for subscribers this bus holds that are not LLM-created
 * agenda items: PersonaService, and plugin-planted watches such as the keyword mines.
 */
const NON_LLM_SUBSCRIBER_HEADROOM = 50;

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
   * Node's default of 10 listeners per event is a leak heuristic — "this many handlers on one
   * event means you probably forgot to remove some". It does not hold here: AgendaService
   * subscribes one handler per live onMessage item and drops it in cancelSchedule, so the count
   * tracks how many watches are currently planted, and a busy day crosses 10 on its own.
   *
   * Sized above the ceiling on live items rather than at a round number, so that a warning from
   * this bus still means what Node intended: handlers accumulating that nobody removes.
   */
  private static readonly MAX_LISTENERS_PER_EVENT =
    DEFAULT_AGENDA_LLM_LIMITS.maxLiveItemsGlobal + NON_LLM_SUBSCRIBER_HEADROOM;

  constructor() {
    super();
    this.setMaxListeners(InternalEventBus.MAX_LISTENERS_PER_EVENT);
  }

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
