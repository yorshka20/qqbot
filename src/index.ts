// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import type { MessageAPI } from './api/methods/MessageAPI';
import { bootstrapApp } from './core/bootstrap';
import { getContainer } from './core/DIContainer';
import { DITokens } from './core/DITokens';
import { ClaudeCodeInitializer } from './services/claudeCode';
import { MCPInitializer } from './services/mcp/MCPInitializer';
import { stopStaticFileServer } from './services/staticServer';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting bot...');

  try {
    // ── Shared initialization (config, DI, tools, plugins, adapters, etc.) ──
    const configPath = process.env.CONFIG_PATH;
    const { bot, mcpSystem, claudeCodeService, conversationComponents, eventRouter, retrievalService } =
      await bootstrapApp(configPath);

    const config = bot.getConfig();

    // ── Live connections (the ONLY things not covered by bootstrapApp) ──

    // Start bot (opens WebSocket connections)
    await bot.start();

    // Connect to MCP servers
    if (mcpSystem) {
      await MCPInitializer.connectServers(mcpSystem, config);
      MCPInitializer.updateRetrievalService(mcpSystem, retrievalService);
    }

    // Start Claude Code service (non-fatal if port is in use)
    if (claudeCodeService) {
      try {
        const container = getContainer();
        const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
        await ClaudeCodeInitializer.start(claudeCodeService, messageAPI);
        const protocols = config.getEnabledProtocols().map((p) => p.name);
        ClaudeCodeInitializer.updateBotInfo(claudeCodeService, config.getConfig().bot.selfId, protocols);
      } catch (error) {
        logger.warn('[Main] Claude Code service failed to start (non-fatal):', error);
      }
    }

    logger.info('[Main] Bot initialized and ready');

    // ── Graceful shutdown ──
    const shutdown = async (signal: string) => {
      logger.info(`[Main] Received ${signal}, shutting down...`);
      stopStaticFileServer();
      await ClaudeCodeInitializer.stop(claudeCodeService);
      await bot.stop();
      eventRouter.destroy();
      await MCPInitializer.disconnectServers(mcpSystem);
      await conversationComponents.databaseManager.close();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    logger.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('[Main] Unhandled error:', error);
  process.exit(1);
});
