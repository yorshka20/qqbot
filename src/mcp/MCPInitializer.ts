// MCP Initializer - initializes MCP system

import type { Config } from '@/core/config';
import type { SearchService } from '@/search';
import { logger } from '@/utils/logger';
import { MCPManager } from './MCPManager';

export interface MCPSystem {
  mcpManager: MCPManager;
}

/**
 * MCP Initializer
 * Initializes MCP system and connects to MCP servers
 */
export class MCPInitializer {
  /**
   * Initialize MCP system
   * @param config - Bot configuration
   * @returns Initialized MCP system
   */
  static initialize(config: Config): MCPSystem | null {
    const mcpConfig = config.getMCPConfig();

    if (!mcpConfig || !mcpConfig.enabled) {
      logger.info('[MCPInitializer] MCP is not enabled in configuration');
      return null;
    }

    if (!mcpConfig.server.enabled) {
      logger.info('[MCPInitializer] MCP server mode is disabled, using direct API mode');
      return null;
    }

    logger.info('[MCPInitializer] Starting MCP system initialization...');

    const mcpManager = new MCPManager();

    logger.info('[MCPInitializer] MCPManager initialized');

    return {
      mcpManager,
    };
  }

  /**
   * Connect to MCP servers
   * @param mcpSystem - MCP system from initialize
   * @param config - Bot configuration
   */
  static async connectServers(mcpSystem: MCPSystem | null, config: Config): Promise<void> {
    if (!mcpSystem) {
      return;
    }

    const mcpConfig = config.getMCPConfig();
    if (!mcpConfig || !mcpConfig.enabled || !mcpConfig.server.enabled) {
      return;
    }

    try {
      // Register searxng MCP server
      await mcpSystem.mcpManager.registerClient('searxng', mcpConfig);
      logger.info('[MCPInitializer] MCP servers connected successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[MCPInitializer] Failed to connect MCP servers:', err);
      throw err;
    }
  }

  /**
   * Update SearchService with MCP manager for MCP mode
   * @param mcpSystem - MCP system
   * @param searchService - Search service
   */
  static updateSearchService(mcpSystem: MCPSystem | null, searchService: SearchService): void {
    if (!mcpSystem) {
      return;
    }

    // Set MCP manager in search service (if it supports MCP mode)
    // This will be implemented when SearchService supports MCP mode
    searchService.setMCPManager(mcpSystem.mcpManager);
    logger.info('[MCPInitializer] SearchService updated with MCP manager');
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
