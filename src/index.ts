// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import { PromptInitializer } from './ai/prompt/PromptInitializer';
import { APIClient } from './api/APIClient';
import { ConversationInitializer } from './conversation/ConversationInitializer';
import { Bot } from './core/Bot';
import { getContainer } from './core/DIContainer';
import { DITokens } from './core/DITokens';
import { HealthCheckManager } from './core/health';
import { ServiceRegistry } from './core/ServiceRegistry';
import { EventInitializer } from './events/EventInitializer';
import { PluginInitializer } from './plugins/PluginInitializer';
import { ProtocolAdapterInitializer } from './protocol/ProtocolAdapterInitializer';
import { MCPInitializer } from './services/mcp/MCPInitializer';
import { RetrievalService } from './services/retrieval';
import { initStaticFileServer, stopStaticFileServer } from './services/staticServer';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting bot...');

  try {
    // Load configuration
    const configPath = process.env.CONFIG_PATH;
    const bot = new Bot(configPath);
    const config = bot.getConfig();
    const connectionManager = bot.getConnectionManager();

    const container = getContainer();

    // Initialize API client
    const apiConfig = config.getAPIConfig();
    const apiClient = new APIClient(apiConfig.strategy, apiConfig.preferredProtocol);

    // Initialize prompt system (before conversation initialization)
    PromptInitializer.initialize(config);

    // Plugin system
    PluginInitializer.initialize(config);

    // Initialize MCP system (if enabled)
    const mcpSystem = MCPInitializer.initialize(config);

    // Create HealthCheckManager first so it can be injected into RetrievalService / SearchService
    const healthCheckManager = new HealthCheckManager();
    container.registerInstance(DITokens.HEALTH_CHECK_MANAGER, healthCheckManager);
    // Initialize retrieval service (always create; search enabled when mcp.enabled, RAG when rag.enabled)
    const mcpConfig = config.getMCPConfig();
    const ragConfig = config.getRAGConfig();
    const retrievalService = new RetrievalService(mcpConfig, ragConfig, healthCheckManager);
    container.registerInstance(DITokens.RETRIEVAL_SERVICE, retrievalService);
    if (ragConfig?.enabled) {
      logger.info(
        `[Main] RAG enabled | ollama=${ragConfig.ollama?.url} model=${ragConfig.ollama?.model} qdrant=${ragConfig.qdrant?.url}`,
      );
    }

    // Initialize and start static file server for serving generated images
    // This must be done BEFORE ConversationInitializer because ImageGenerationService needs it
    const staticServerConfig = config.getStaticServerConfig();
    if (staticServerConfig) {
      await initStaticFileServer(staticServerConfig);
    }

    // Initialize conversation components
    const conversationComponents = await ConversationInitializer.initialize(config, apiClient);

    // Register RetrievalService health check (after HealthCheckManager is created)
    retrievalService.registerHealthCheck();

    // Initialize event system (EventRouter and handlers)
    const eventSystem = EventInitializer.initialize(
      config,
      conversationComponents.conversationManager,
      conversationComponents.hookManager,
    );
    const eventRouter = eventSystem.eventRouter;
    // Register EventRouter to container
    container.registerInstance(DITokens.EVENT_ROUTER, eventRouter);

    // Verify all required services (EVENT_ROUTER and others now registered)
    new ServiceRegistry().verifyServices();

    // Initialize protocol adapter system (BEFORE starting bot)
    ProtocolAdapterInitializer.initialize(config, connectionManager, eventRouter, apiClient);

    // Start bot (this will trigger connection events)
    await bot.start();

    // Connect to MCP servers (after bot is started)
    if (mcpSystem) {
      await MCPInitializer.connectServers(mcpSystem, config);
      // Update RetrievalService with MCP manager for MCP mode
      MCPInitializer.updateRetrievalService(mcpSystem, retrievalService);
    }

    // Load plugins after bot is started
    await PluginInitializer.loadPlugins(config);

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
