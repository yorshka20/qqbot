// Base class for plugins

import type { APIClient } from '@/api/APIClient';
import type { EventRouter } from '@/events/EventRouter';
import type { EventHandler, NormalizedEvent } from '@/events/types';
import { PluginOptions } from './decorators';
import type { PluginContext } from './types';

export abstract class PluginBase {
  readonly name: string;
  readonly version: string;
  readonly description: string;

  author?: string;

  protected enabled: boolean = false;

  protected context?: PluginContext;

  constructor(options: PluginOptions) {
    this.name = options.name;
    this.version = options.version;
    this.description = options.description;
  }

  onInit?(context: PluginContext): void | Promise<void>;
  onEnable?(context: PluginContext): void | Promise<void>;
  onDisable?(): void | Promise<void>;

  protected on<T extends NormalizedEvent>(eventType: string, handler: EventHandler<T>): void {
    if (!this.context) {
      throw new Error('Plugin context not initialized');
    }
    this.context.events.onEvent(eventType, handler);
  }

  protected off<T extends NormalizedEvent>(eventType: string, handler: EventHandler<T>): void {
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
