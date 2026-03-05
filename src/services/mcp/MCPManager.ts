// MCP Manager - manages multiple MCP clients

import type { MCPConfig } from '@/core/config/mcp';
import { logger } from '@/utils/logger';
import { MCPClient } from './MCPClient';
import type { MCPTool, MCPToolCallResult } from './types';

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private tools = new Map<string, { clientName: string; tool: MCPTool }>();

  /**
   * Register an MCP client
   */
  async registerClient(name: string, config: MCPConfig): Promise<void> {
    if (this.clients.has(name)) {
      logger.warn(`[MCPManager] Client ${name} already registered, replacing...`);
      await this.unregisterClient(name);
    }

    try {
      const client = new MCPClient();
      await client.connect(config);

      // List and register tools from this client
      const availableTools = await client.listTools();
      for (const tool of availableTools) {
        this.tools.set(tool.name, { clientName: name, tool });
        logger.debug(`[MCPManager] Registered tool: ${tool.name} from client ${name}`);
      }

      this.clients.set(name, client);
      logger.info(`[MCPManager] Registered MCP client: ${name} with ${availableTools.length} tools`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[MCPManager] Failed to register client ${name}:`, err);
      throw err;
    }
  }

  /**
   * Unregister an MCP client
   */
  async unregisterClient(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        logger.warn(`[MCPManager] Error disconnecting client ${name}:`, error);
      }
      this.clients.delete(name);

      // Remove tools from this client
      for (const [toolName, toolInfo] of this.tools.entries()) {
        if (toolInfo.clientName === name) {
          this.tools.delete(toolName);
        }
      }

      logger.info(`[MCPManager] Unregistered MCP client: ${name}`);
    }
  }

  /**
   * Call a tool by name
   */
  async callTool(toolName: string, arguments_: Record<string, unknown>): Promise<MCPToolCallResult> {
    const toolInfo = this.tools.get(toolName);
    if (!toolInfo) {
      throw new Error(`Tool ${toolName} not found`);
    }

    const client = this.clients.get(toolInfo.clientName);
    if (!client) {
      throw new Error(`Client ${toolInfo.clientName} not found`);
    }

    return await client.callTool(toolName, arguments_);
  }

  /**
   * List all available tools
   */
  listTools(): MCPTool[] {
    return Array.from(this.tools.values()).map((info) => info.tool);
  }

  /**
   * Get tool by name
   */
  getTool(toolName: string): MCPTool | undefined {
    return this.tools.get(toolName)?.tool;
  }

  /**
   * Check if a tool exists
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Disconnect all clients
   */
  async disconnectAll(): Promise<void> {
    const clientNames = Array.from(this.clients.keys());
    for (const name of clientNames) {
      await this.unregisterClient(name);
    }
    logger.info('[MCPManager] All MCP clients disconnected');
  }

  /**
   * Get all registered client names
   */
  getClientNames(): string[] {
    return Array.from(this.clients.keys());
  }
}
