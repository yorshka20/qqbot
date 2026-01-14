// MCP Client - wraps official MCP SDK

import type { MCPConfig, MCPRuntime } from '@/core/config/mcp';
import { logger } from '@/utils/logger';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPTool, MCPToolCallResult } from './types';

export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private isConnected = false;

  /**
   * Connect to MCP server
   */
  async connect(config: MCPConfig): Promise<void> {
    if (this.isConnected) {
      logger.warn('[MCPClient] Already connected, disconnecting first...');
      await this.disconnect();
    }

    try {
      // Build command and arguments based on runtime
      const { command, args } = this.getRuntimeCommand(config.server.runtime, config.server.package || 'mcp-searxng');

      // Build environment variables
      const env: Record<string, string> = {
        SEARXNG_URL: config.searxng.url,
        ...(config.searxng.authUsername && {
          AUTH_USERNAME: config.searxng.authUsername,
        }),
        ...(config.searxng.authPassword && {
          AUTH_PASSWORD: config.searxng.authPassword,
        }),
        ...(config.searxng.userAgent && {
          USER_AGENT: config.searxng.userAgent,
        }),
        ...process.env, // Preserve existing environment variables
      };

      // Set proxy environment variables if configured
      if (config.searxng.proxy?.http) {
        env.HTTP_PROXY = config.searxng.proxy.http;
      }
      if (config.searxng.proxy?.https) {
        env.HTTPS_PROXY = config.searxng.proxy.https;
      }

      logger.debug(`[MCPClient] Connecting to MCP server: ${command} ${args.join(' ')}`);

      this.transport = new StdioClientTransport({
        command,
        args,
        env,
      });

      this.client = new Client(
        {
          name: 'qqbot',
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );

      await this.client.connect(this.transport);
      this.isConnected = true;
      logger.info('[MCPClient] MCP server connected successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[MCPClient] Failed to connect to MCP server:', err);
      this.isConnected = false;
      throw err;
    }
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
        logger.info('[MCPClient] MCP server disconnected');
      } catch (error) {
        logger.warn('[MCPClient] Error during disconnect:', error);
      }
      this.client = null;
      this.transport = null;
      this.isConnected = false;
    }
  }

  /**
   * List available tools from MCP server
   */
  async listTools(): Promise<MCPTool[]> {
    if (!this.client || !this.isConnected) {
      throw new Error('MCP client not connected');
    }

    try {
      const tools = await this.client.listTools();
      return tools.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as MCPTool['inputSchema'],
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[MCPClient] Failed to list tools:', err);
      throw err;
    }
  }

  /**
   * Call a tool on MCP server
   */
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<MCPToolCallResult> {
    if (!this.client || !this.isConnected) {
      throw new Error('MCP client not connected');
    }

    try {
      logger.debug(`[MCPClient] Calling tool: ${name} with arguments:`, arguments_);
      const result = await this.client.callTool({
        name,
        arguments: arguments_,
      });

      // Convert result to our format
      const content = result.content || [];
      const isError = result.isError ?? false;

      return {
        content: content as MCPToolCallResult['content'],
        isError: isError as boolean,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[MCPClient] Failed to call tool ${name}:`, err);
      throw err;
    }
  }

  /**
   * Get runtime command and arguments
   */
  private getRuntimeCommand(runtime: MCPRuntime, packageName: string): { command: string; args: string[] } {
    switch (runtime) {
      case 'bunx':
        return {
          command: 'bunx',
          args: ['-y', packageName],
        };
      case 'npx':
        return {
          command: 'npx',
          args: ['-y', packageName],
        };
      case 'npm':
        return {
          command: 'npm',
          args: ['run', packageName], // Assumes global installation
        };
      default:
        throw new Error(`Unsupported runtime: ${runtime}`);
    }
  }

  /**
   * Check if client is connected
   */
  getConnected(): boolean {
    return this.isConnected;
  }
}
