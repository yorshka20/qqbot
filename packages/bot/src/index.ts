// Main entry point
// IMPORTANT: reflect-metadata must be imported FIRST before any other imports
import 'reflect-metadata';

import type { AIManager } from './ai/AIManager';
import type { MessageAPI } from './api/methods/MessageAPI';
import { bootstrapApp } from './core/bootstrap';
import { getContainer } from './core/DIContainer';
import { DITokens } from './core/DITokens';
import { initLanRelay } from './lan';
import { ClaudeCodeInitializer } from './services/claudeCode';
import { MCPInitializer } from './services/mcp/MCPInitializer';
import { stopStaticServer } from './services/staticServer';
import type { ResourceCleanupService } from './services/video';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting bot...');

  try {
    // ── Shared initialization (config, DI, tools, plugins, adapters, etc.) ──
    const configPath = process.env.CONFIG_PATH;
    const {
      bot,
      mcpSystem,
      claudeCodeService,
      clusterManager,
      conversationComponents,
      eventRouter,
      retrievalService,
      avatarService,
    } = await bootstrapApp(configPath);

    const config = bot.getConfig();
    const container = getContainer();
    const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
    let resourceCleanupService: ResourceCleanupService | null = null;
    try {
      resourceCleanupService = container.resolve<ResourceCleanupService>(DITokens.RESOURCE_CLEANUP_SERVICE);
    } catch (error) {
      logger.warn('[Main] ResourceCleanupService is unavailable during shutdown setup:', error);
    }
    const deleteRemoteFile = (() => {
      try {
        const aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);
        const geminiProvider = aiManager.getProvider('gemini') as unknown as
          | { deleteUploadedFile(fileName: string): Promise<void> }
          | undefined;

        if (!geminiProvider) {
          return undefined;
        }

        return async (fileName: string) => {
          await geminiProvider.deleteUploadedFile(fileName);
        };
      } catch {
        return undefined;
      }
    })();

    // ── Live connections (the ONLY things not covered by bootstrapApp) ──

    // Start bot (opens WebSocket connections)
    await bot.start();

    // Start avatar system (connects to VTubeStudio driver, non-fatal)
    if (avatarService) {
      try {
        await avatarService.start();
      } catch (error) {
        logger.warn('[Main] Avatar service failed to start (non-fatal):', error);
      }
    }

    // Pull rawDb (sqlite only) so the host can persist client internal_report
    // envelopes into `lan_internal_reports`. Non-sqlite deployments pass null
    // and reports just log to console.
    let rawDb: import('bun:sqlite').Database | null = null;
    try {
      const adapter = conversationComponents.databaseManager.getAdapter() as unknown as {
        getRawDb?: () => import('bun:sqlite').Database | null;
      };
      // Duck-type: SQLiteAdapter exposes getRawDb(); other adapters do not.
      if (typeof adapter.getRawDb === 'function') {
        rawDb = adapter.getRawDb();
      }
    } catch {
      rawDb = null;
    }
    const lanRelayHandle = await initLanRelay({ config, eventRouter, messageAPI, rawDb });

    // Connect to MCP servers
    if (mcpSystem) {
      await MCPInitializer.connectServers(mcpSystem, config);
      MCPInitializer.updateRetrievalService(mcpSystem, retrievalService);
    }

    // Start Claude Code service (non-fatal if port is in use)
    if (claudeCodeService) {
      try {
        await ClaudeCodeInitializer.start(claudeCodeService, messageAPI);
        const protocols = config.getEnabledProtocols().map((p) => p.name);
        ClaudeCodeInitializer.updateBotInfo(claudeCodeService, config.getConfig().bot.selfId, protocols);
      } catch (error) {
        logger.warn('[Main] Claude Code service failed to start (non-fatal):', error);
      }
    }

    // Start Agent Cluster (non-fatal)
    if (clusterManager) {
      try {
        await clusterManager.start();
      } catch (error) {
        logger.warn('[Main] Agent Cluster failed to start (non-fatal):', error);
      }
    }

    logger.info('[Main] Bot initialized and ready');

    // ── Graceful shutdown ──
    const shutdown = async (signal: string) => {
      logger.info(`[Main] Received ${signal}, shutting down...`);
      stopStaticServer();
      if (resourceCleanupService) {
        await resourceCleanupService.cleanupAll(deleteRemoteFile);
      }
      if (avatarService) {
        await avatarService.stop();
      }
      if (clusterManager) {
        await clusterManager.stop();
      }
      await lanRelayHandle.stop();
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
