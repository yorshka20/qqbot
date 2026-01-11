// Plugin type definitions

import type { APIClient } from '@/api/APIClient';
import type { EventRouter } from '@/events/EventRouter';
import type { NormalizedEvent } from '@/events/types';
import type { EventHandler } from '@/events/types';

export interface PluginContext {
  api: APIClient;
  events: EventRouter;
  bot: {
    getConfig: () => unknown;
  };
}

export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
}

export interface Plugin extends PluginInfo {
  onInit?(context: PluginContext): void | Promise<void>;
  onEnable?(context: PluginContext): void | Promise<void>;
  onDisable?(): void | Promise<void>;
}
