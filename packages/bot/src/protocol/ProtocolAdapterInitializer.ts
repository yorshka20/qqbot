// Protocol Adapter Initializer - sets up protocol adapters and connects them to event router

import type { APIClient } from '@/api/APIClient';
import type { Config, ProtocolName } from '@/core/config';
import type { ConnectionManager, WebSocketConnection } from '@/core/connection';
import type { EventRouter } from '@/events/EventRouter';
import type { NormalizedEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { ProtocolAdapter } from './base/ProtocolAdapter';
import type { BaseEvent } from './base/types';
import { DiscordAdapter } from './discord/DiscordAdapter';
import type { DiscordConnection } from './discord/DiscordConnection';
import { MilkyAdapter } from './milky';
import { OneBot11Adapter } from './onebot11/OneBot11Adapter';
import { registerProtocol, unregisterProtocol } from './ProtocolRegistry';
import { SatoriAdapter } from './satori/SatoriAdapter';

export interface ProtocolAdapterSystem {
  adapters: Map<ProtocolName, { adapter: ProtocolAdapter; connection: unknown }>;
}

/**
 * Protocol Adapter Initializer
 * Pure wiring: creates adapters, registers them with event router / API client / protocol registry.
 * No business logic — send methods live on the adapters themselves.
 */
export class ProtocolAdapterInitializer {
  static initialize(
    config: Config,
    connectionManager: ConnectionManager,
    eventRouter: EventRouter,
    apiClient: APIClient,
  ): ProtocolAdapterSystem {
    logger.info('[ProtocolAdapterInitializer] Starting initialization...');

    const adapters = new Map<ProtocolName, { adapter: ProtocolAdapter; connection: unknown }>();

    connectionManager.on('connectionOpen', async (protocolName, connection) => {
      const protocolConfig = config.getProtocolConfig(protocolName as ProtocolName);
      if (!protocolConfig) {
        logger.error(`[ProtocolAdapterInitializer] Protocol config not found for: ${protocolName}`);
        return;
      }

      const proto = protocolName as ProtocolName;
      let adapter: ProtocolAdapter;
      let selfId: string | undefined;

      switch (protocolName) {
        case 'onebot11':
          adapter = new OneBot11Adapter(protocolConfig, connection as WebSocketConnection);
          break;
        case 'milky':
          adapter = new MilkyAdapter(protocolConfig, connection as WebSocketConnection);
          break;
        case 'satori':
          adapter = new SatoriAdapter(protocolConfig, connection as WebSocketConnection);
          break;
        case 'discord': {
          const discordConn = connection as unknown as DiscordConnection;
          adapter = new DiscordAdapter(protocolConfig, discordConn);
          selfId = discordConn.getBotUserId() || undefined;
          break;
        }
        default:
          logger.error(`[ProtocolAdapterInitializer] Unknown protocol: ${protocolName}`);
          return;
      }

      // Register adapter in protocol registry (for sendMessage / capability queries)
      registerProtocol(protocolName, { selfId, adapter });

      // Set up adapter event handling
      adapter.onEvent((event: BaseEvent) => {
        if (event && typeof event === 'object' && 'type' in event) {
          eventRouter.routeEvent(event as NormalizedEvent);
        }
      });

      // Register adapter with API client (for low-level sendAPI calls)
      apiClient.registerAdapter(proto, adapter);
      adapters.set(proto, { adapter, connection });

      logger.info(`[ProtocolAdapterInitializer] Adapter registered for protocol: ${protocolName}`);
    });

    connectionManager.on('connectionClose', (protocolName) => {
      logger.info(`[ProtocolAdapterInitializer] Connection closed for protocol: ${protocolName}`);
      unregisterProtocol(protocolName);
      apiClient.unregisterAdapter(protocolName as ProtocolName);
      adapters.delete(protocolName as ProtocolName);
    });

    logger.info('[ProtocolAdapterInitializer] Protocol adapter system initialized');

    return { adapters };
  }
}
