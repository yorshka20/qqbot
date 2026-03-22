// Protocol Adapter Initializer - sets up protocol adapters and connects them to event router

import type { APIClient } from '@/api/APIClient';
import type { ConnectionManager } from '@/core/ConnectionManager';
import type { Config, ProtocolName } from '@/core/config';
import type { EventRouter } from '@/events/EventRouter';
import type { NormalizedEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { BaseEvent, ProtocolAdapter } from './base/types';
import { DiscordAdapter } from './discord/DiscordAdapter';
import type { DiscordConnection } from './discord/DiscordConnection';
import { MilkyAdapter } from './milky';
import { OneBot11Adapter } from './onebot11/OneBot11Adapter';
import { SatoriAdapter } from './satori/SatoriAdapter';

export interface ProtocolAdapterSystem {
  adapters: Map<ProtocolName, { adapter: any; connection: any }>;
}

/**
 * Protocol Adapter Initializer
 * Sets up protocol adapters and connects them to event router and API client
 */
export class ProtocolAdapterInitializer {
  static initialize(
    config: Config,
    connectionManager: ConnectionManager,
    eventRouter: EventRouter,
    apiClient: APIClient,
  ): ProtocolAdapterSystem {
    logger.info('[ProtocolAdapterInitializer] Starting initialization...');

    const adapters = new Map<ProtocolName, { adapter: any; connection: any }>();

    connectionManager.on('connectionOpen', async (protocolName, connection) => {
      let adapter: any;
      const protocolConfig = config.getProtocolConfig(protocolName as ProtocolName);

      if (!protocolConfig) {
        logger.error(`[ProtocolAdapterInitializer] Protocol config not found for: ${protocolName}`);
        return;
      }

      // Create appropriate adapter based on protocol name
      switch (protocolName) {
        case 'onebot11':
          adapter = new OneBot11Adapter(protocolConfig, connection);
          break;
        case 'milky':
          adapter = new MilkyAdapter(protocolConfig, connection);
          break;
        case 'satori':
          adapter = new SatoriAdapter(protocolConfig, connection);
          break;
        case 'discord':
          adapter = new DiscordAdapter(protocolConfig, connection as unknown as DiscordConnection);
          break;
        default:
          logger.error(`[ProtocolAdapterInitializer] Unknown protocol: ${protocolName}`);
          return;
      }

      // Set up adapter event handling
      adapter.onEvent((event: BaseEvent) => {
        if (event && typeof event === 'object' && 'type' in event) {
          eventRouter.routeEvent(event as NormalizedEvent);
        }
      });

      // Register adapter with API client
      apiClient.registerAdapter(protocolName as ProtocolName, adapter);
      adapters.set(protocolName as ProtocolName, { adapter, connection });

      logger.info(`[ProtocolAdapterInitializer] Adapter registered for protocol: ${protocolName}`);
    });

    connectionManager.on('connectionClose', (protocolName) => {
      logger.info(`[ProtocolAdapterInitializer] Connection closed for protocol: ${protocolName}`);
      apiClient.unregisterAdapter(protocolName as ProtocolName);
      adapters.delete(protocolName as ProtocolName);
    });

    logger.info('[ProtocolAdapterInitializer] Protocol adapter system initialized');

    return {
      adapters,
    };
  }
}
