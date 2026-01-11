// Main entry point

import { APIClient } from './api/APIClient';
import { Bot } from './core/Bot';
import type { ProtocolName } from './core/Config';
import { EventRouter } from './events/EventRouter';
import { MessageHandler } from './events/handlers/MessageHandler';
import { MetaEventHandler } from './events/handlers/MetaEventHandler';
import { NoticeHandler } from './events/handlers/NoticeHandler';
import { RequestHandler } from './events/handlers/RequestHandler';
import type { NormalizedEvent } from './events/types';
import { PluginManager } from './plugins/PluginManager';
import { MilkyAdapter } from './protocol/milky/MilkyAdapter';
import { OneBot11Adapter } from './protocol/onebot11/OneBot11Adapter';
import { SatoriAdapter } from './protocol/satori/SatoriAdapter';
import { logger } from './utils/logger';

async function main() {
  try {
    // Load configuration
    const configPath = process.env.CONFIG_PATH;
    const bot = new Bot(configPath);
    const config = bot.getConfig();
    const connectionManager = bot.getConnectionManager();

    // Initialize API client
    const apiConfig = config.getAPIConfig();
    const apiClient = new APIClient(
      apiConfig.strategy,
      apiConfig.preferredProtocol,
    );

    // Initialize event router
    const eventDeduplicationConfig = config.getEventDeduplicationConfig();
    const eventRouter = new EventRouter(eventDeduplicationConfig);

    // Set up event handlers
    const messageHandler = new MessageHandler();
    const noticeHandler = new NoticeHandler();
    const requestHandler = new RequestHandler();
    const metaEventHandler = new MetaEventHandler();

    eventRouter.on('message', (event) => {
      messageHandler.handle(event);
    });

    eventRouter.on('notice', (event) => {
      noticeHandler.handle(event);
    });

    eventRouter.on('request', (event) => {
      requestHandler.handle(event);
    });

    eventRouter.on('meta_event', (event) => {
      metaEventHandler.handle(event);
    });

    // Set up protocol adapters BEFORE starting bot
    const adapters = new Map<ProtocolName, { adapter: any; connection: any }>();

    connectionManager.on('connectionOpen', async (protocolName, connection) => {
      logger.info(`[Main] Setting up adapter for protocol: ${protocolName}`);

      let adapter;
      const protocolConfig = config.getProtocolConfig(
        protocolName as ProtocolName,
      );

      if (!protocolConfig) {
        logger.error(`[Main] Protocol config not found for: ${protocolName}`);
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
        default:
          logger.error(`[Main] Unknown protocol: ${protocolName}`);
          return;
      }

      // Set up adapter event handling
      adapter.onEvent((event) => {
        // Event is BaseEvent from adapter, but routeEvent expects NormalizedEvent
        // Since adapters normalize events to match NormalizedEvent structure,
        // we can safely cast. The actual normalization happens in normalizeEvent()
        if (event && typeof event === 'object' && 'type' in event) {
          eventRouter.routeEvent(event as NormalizedEvent);
        }
      });

      // Register adapter with API client
      apiClient.registerAdapter(protocolName as ProtocolName, adapter);
      adapters.set(protocolName as ProtocolName, { adapter, connection });

      logger.info(`[Main] Adapter registered for protocol: ${protocolName}`);
    });

    connectionManager.on('connectionClose', (protocolName) => {
      logger.info(`[Main] Connection closed for protocol: ${protocolName}`);
      apiClient.unregisterAdapter(protocolName as ProtocolName);
      adapters.delete(protocolName as ProtocolName);
    });

    // Initialize plugin manager before starting bot
    const pluginsConfig = config.getPluginsConfig();
    const pluginManager = new PluginManager(pluginsConfig.directory);
    pluginManager.setContext({
      api: apiClient,
      events: eventRouter,
      bot: {
        getConfig: () => config.getConfig(),
      },
    });

    // Start bot (this will trigger connection events)
    await bot.start();

    // Load plugins after bot is started
    await pluginManager.loadPlugins(pluginsConfig.enabled);

    logger.info('[Main] Bot initialized and ready');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('[Main] Received SIGINT, shutting down...');
      await bot.stop();
      eventRouter.destroy();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('[Main] Received SIGTERM, shutting down...');
      await bot.stop();
      eventRouter.destroy();
      process.exit(0);
    });
  } catch (error) {
    logger.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  logger.error('[Main] Unhandled error:', error);
  process.exit(1);
});
