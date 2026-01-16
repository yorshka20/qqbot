// Plugin type definitions

import type { APIClient } from '@/api/APIClient';
import type { BotConfig } from '@/core/config';
import type { EventRouter } from '@/events/EventRouter';
import type { PluginHooks } from '@/hooks';

export interface PluginContext {
  api: APIClient;
  events: EventRouter;
  bot: {
    getConfig: () => BotConfig;
  };
}

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
}

/**
 * Plugin configuration entry from config.plugins.list
 */
export interface PluginConfigEntry {
  name: string;
  enabled: boolean;
  config?: unknown;
}

/**
 * Plugin interface
 * Extends PluginHooks to support hook methods
 * Hooks are registered via @Hook() decorator, not through interface methods
 */
export interface Plugin extends PluginInfo, PluginHooks {
  loadConfig(context: PluginContext, pluginEntry?: PluginConfigEntry): void;
  onInit?(): void | Promise<void>;
  onEnable?(): void | Promise<void>;
  onDisable?(): void | Promise<void>;
}
