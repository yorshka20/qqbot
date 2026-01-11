// Base class for plugins

import type { PluginContext } from './types';
import type { NormalizedEvent, EventHandler } from '@/events/types';
import type { APIClient } from '@/api/APIClient';
import type { EventRouter } from '@/events/EventRouter';

export abstract class PluginBase {
  abstract readonly name: string;
  abstract readonly version: string;
  description?: string;
  author?: string;

  protected context?: PluginContext;

  onInit?(context: PluginContext): void | Promise<void>;
  onEnable?(context: PluginContext): void | Promise<void>;
  onDisable?(): void | Promise<void>;

  protected on<T extends NormalizedEvent>(
    eventType: string,
    handler: EventHandler<T>
  ): void {
    if (!this.context) {
      throw new Error('Plugin context not initialized');
    }
    this.context.events.onEvent(eventType, handler);
  }

  protected off<T extends NormalizedEvent>(
    eventType: string,
    handler: EventHandler<T>
  ): void {
    if (!this.context) {
      throw new Error('Plugin context not initialized');
    }
    this.context.events.offEvent(eventType, handler);
  }

  get api(): APIClient {
    if (!this.context) {
      throw new Error('Plugin context not initialized');
    }
    return this.context.api;
  }

  get events(): EventRouter {
    if (!this.context) {
      throw new Error('Plugin context not initialized');
    }
    return this.context.events;
  }
}
