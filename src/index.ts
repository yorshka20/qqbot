// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import { PromptInitializer } from './ai/PromptInitializer';
import { APIClient } from './api/APIClient';
import { ConversationInitializer } from './conversation/ConversationInitializer';
import { Bot } from './core/Bot';
import { EventInitializer } from './events/EventInitializer';
import { MCPInitializer } from './mcp/MCPInitializer';
import { PluginInitializer } from './plugins/PluginInitializer';
import { ProtocolAdapterInitializer } from './protocol/ProtocolAdapterInitializer';
import { SearchService } from './search';
import { logger } from './utils/logger';
import { initStaticFileServer, stopStaticFileServer } from './utils/StaticFileServer';

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

    // Initialize MCP system (if enabled)
    const mcpSystem = MCPInitializer.initialize(config);

    // Initialize search service (if MCP is enabled)
    let searchService: SearchService | undefined;
    const mcpConfig = config.getMCPConfig();
    if (mcpConfig && mcpConfig.enabled) {
      searchService = new SearchService(mcpConfig);
      logger.info('[Main] SearchService initialized');
    }

    // Initialize conversation components
    const conversationComponents = await ConversationInitializer.initialize(config, apiClient, searchService);

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

    // Initialize and start static file server for serving generated images
    // This starts the server once and keeps it running
    const staticServerConfig = config.getStaticServerConfig();
    if (staticServerConfig) {
      await initStaticFileServer(staticServerConfig.port, staticServerConfig.root, staticServerConfig.host);
    }

    // Start bot (this will trigger connection events)
    await bot.start();

    // Connect to MCP servers (after bot is started)
    if (mcpSystem) {
      await MCPInitializer.connectServers(mcpSystem, config);
      // Update SearchService with MCP manager for MCP mode
      if (searchService) {
        MCPInitializer.updateSearchService(mcpSystem, searchService);
      }
    }

    // Load plugins after bot is started
    await PluginInitializer.loadPlugins(pluginSystem, config);

    logger.info('[Main] Bot initialized and ready');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('[Main] Received SIGINT, shutting down...');
      stopStaticFileServer();
      await bot.stop();
      eventRouter.destroy();
      await MCPInitializer.disconnectServers(mcpSystem);
      await conversationComponents.databaseManager.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('[Main] Received SIGTERM, shutting down...');
      stopStaticFileServer();
      await bot.stop();
      eventRouter.destroy();
      await MCPInitializer.disconnectServers(mcpSystem);
      await conversationComponents.databaseManager.close();
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
