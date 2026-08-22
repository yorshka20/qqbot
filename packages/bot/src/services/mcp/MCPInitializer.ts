// MCP Initializer - initializes MCP system

import type { Config } from '@/core/config';
import type { MCPConfig } from '@/core/config/types/mcp';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import { MCPManager } from './MCPManager';
import { reapOrphanedMcpChildren } from './mcpChildReaper';

export interface MCPSystem {
  mcpManager: MCPManager;
  mcpConfig: MCPConfig;
}

/**
 * MCP Initializer
 * Initializes MCP system and connects to MCP servers
 */
export class MCPInitializer {
  /**
   * Initialize MCP system
   * @param config - Bot configuration
   * @returns Initialized MCP system, or null when search does not route through MCP
   */
  static initialize(config: Config): MCPSystem | null {
    const mcpConfig = config.getMCPConfig();

    if (!mcpConfig?.enabled) {
      logger.info('[MCPInitializer] MCP is not enabled in configuration');
      return null;
    }

    if (!mcpConfig.server.enabled) {
      logger.info('[MCPInitializer] MCP server mode is disabled, using direct API mode');
      return null;
    }

    // SearXNG search is the only consumer of these tools, and it only calls
    // them under provider=searxng + mode=mcp. Registering a client outside
    // that combination spawns a stdio child that nothing can ever call.
    const provider = mcpConfig.search.provider ?? 'searxng';
    if (provider !== 'searxng' || mcpConfig.search.mode !== 'mcp') {
      logger.info(
        `[MCPInitializer] Search does not route through MCP (provider=${provider}, mode=${mcpConfig.search.mode}), skipping MCP client`,
      );
      return null;
    }

    logger.info('[MCPInitializer] Starting MCP system initialization...');

    const mcpManager = new MCPManager();

    logger.info('[MCPInitializer] MCPManager initialized');

    return {
      mcpManager,
      mcpConfig,
    };
  }

  /**
   * Connect to MCP servers
   * @param mcpSystem - MCP system from initialize
   */
  static async connectServers(mcpSystem: MCPSystem | null): Promise<void> {
    if (!mcpSystem) {
      return;
    }

    const { mcpManager, mcpConfig } = mcpSystem;

    try {
      // Reclaim any subtree leaked by a previous SIGKILL'd bot before
      // spawning a fresh one (see reapOrphanedMcpChildren for why).
      reapOrphanedMcpChildren(mcpConfig.server.package || 'mcp-searxng');

      // Register searxng MCP server
      await mcpManager.registerClient('searxng', mcpConfig);
      logger.info('[MCPInitializer] MCP servers connected successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[MCPInitializer] Failed to connect MCP servers:', err);
      throw err;
    }
  }

  /**
   * Update RetrievalService with MCP manager for MCP mode
   * @param mcpSystem - MCP system
   * @param retrievalService - Retrieval service
   */
  static updateRetrievalService(mcpSystem: MCPSystem | null, retrievalService: RetrievalService): void {
    if (!mcpSystem) {
      return;
    }

    retrievalService.setMCPManager(mcpSystem.mcpManager);
    logger.info('[MCPInitializer] RetrievalService updated with MCP manager');
  }

  /**
   * Disconnect all MCP servers
   * @param mcpSystem - MCP system
   */
  static async disconnectServers(mcpSystem: MCPSystem | null): Promise<void> {
    if (!mcpSystem) {
      return;
    }

    try {
      await mcpSystem.mcpManager.disconnectAll();
      logger.info('[MCPInitializer] MCP servers disconnected');
    } catch (error) {
      logger.warn('[MCPInitializer] Error disconnecting MCP servers:', error);
    }
  }
}
