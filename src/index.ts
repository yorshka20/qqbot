// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import { PromptInitializer } from './ai/PromptInitializer';
import { APIClient } from './api/APIClient';
import { ConversationInitializer } from './conversation/ConversationInitializer';
import { Bot } from './core/Bot';
import { EventInitializer } from './events/EventInitializer';
import { PluginInitializer } from './plugins/PluginInitializer';
import { ProtocolAdapterInitializer } from './protocol/ProtocolAdapterInitializer';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting bot...');

  try {
    // Load configuration
    const configPath = process.env.CONFIG_PATH;
    const bot = new Bot(configPath);
    const config = bot.getConfig();
    const connectionManager = bot.getConnectionManager();

    // Initialize API client
    const apiConfig = config.getAPIConfig();
    const apiClient = new APIClient(apiConfig.strategy, apiConfig.preferredProtocol);

    // Initialize prompt system (before conversation initialization)
    PromptInitializer.initialize(config);

    // Initialize conversation components
    const conversationComponents = await ConversationInitializer.initialize(config, apiClient);

    // Initialize event system (EventRouter and handlers)
    const eventSystem = EventInitializer.initialize(config, conversationComponents.conversationManager);
    const eventRouter = eventSystem.eventRouter;

    // Initialize protocol adapter system (BEFORE starting bot)
    ProtocolAdapterInitializer.initialize(config, connectionManager, eventRouter, apiClient);

    // Initialize plugin system
    const pluginSystem = PluginInitializer.initialize(
      config,
      conversationComponents.hookManager,
      apiClient,
      eventRouter,
    );

    // Start bot (this will trigger connection events)
    await bot.start();

    // Load plugins after bot is started
    await PluginInitializer.loadPlugins(pluginSystem, config);

    logger.info('[Main] Bot initialized and ready');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('[Main] Received SIGINT, shutting down...');
      await bot.stop();
      eventRouter.destroy();
      if (conversationComponents.databaseManager) {
        await conversationComponents.databaseManager.close();
      }
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('[Main] Received SIGTERM, shutting down...');
      await bot.stop();
      eventRouter.destroy();
      if (conversationComponents.databaseManager) {
        await conversationComponents.databaseManager.close();
      }
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
