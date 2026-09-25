// Base class for plugins

import type { APIClient } from '@/api/APIClient';
import type { EventRouter } from '@/events/EventRouter';
import type { EventHandler, NormalizedEvent } from '@/events/types';
import type { PluginOptions } from './decorators';
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

  // Lifecycle contract:
  // - onInit runs for every loaded plugin, enabled or not, before any connection exists:
  //   read config and resolve dependencies only — no timers, child processes or I/O.
  // - onEnable / onDisable do in-memory registration (commands, listeners, tasks) and
  //   undo each other, so a plugin can be toggled at runtime.
  // - onStart / onStop own everything that touches the outside world or runs later
  //   (timers, crons, servers, startup jobs). onStart runs once the app is connected, or
  //   on enable after that; onStop undoes it, before onDisable and on shutdown.
  onInit?(): void | Promise<void>;

  onEnable(): void | Promise<void> {
    this.enabled = true;
  }

  onDisable(): void | Promise<void> {
    this.enabled = false;
  }

  onStart?(): void | Promise<void>;

  onStop?(): void | Promise<void>;

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
