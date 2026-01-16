// Base class for plugins

import type { APIClient } from '@/api/APIClient';
import type { EventRouter } from '@/events/EventRouter';
import type { EventHandler, NormalizedEvent } from '@/events/types';
import { PluginOptions } from './decorators';
import type { PluginConfigEntry, PluginContext } from './types';

export abstract class PluginBase {
  readonly name: string;
  readonly version: string;
  readonly description: string;

  author?: string;
  enabled: boolean = false;

  protected context!: PluginContext;
  protected pluginConfig?: PluginConfigEntry;

  constructor(options: PluginOptions) {
    this.name = options.name;
    this.version = options.version;
    this.description = options.description;
  }

  /**
   * Load plugin configuration
   * Called during plugin registration to save config and set enabled state
   * @param pluginEntry - Plugin configuration entry from config.plugins.list
   */
  public loadConfig(context: PluginContext, pluginEntry?: PluginConfigEntry): void {
    this.context = context;
    this.pluginConfig = pluginEntry;
    this.enabled = pluginEntry?.enabled ?? false;
  }

  onInit?(): void | Promise<void>;

  onEnable(): void | Promise<void> {
    this.enabled = true;
  }

  onDisable(): void | Promise<void> {
    this.enabled = false;
  }

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
