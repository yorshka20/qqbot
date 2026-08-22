// SearXNG search over the MCP stdio transport (the alternative to SearXNGClient's direct HTTP).

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPConfig, MCPRuntime } from '@/core/config/types/mcp';
import { logger } from '@/utils/logger';
import { killMcpChild, reapOrphanedMcpChildren, registerMcpChild } from './childReaper';
import type { MCPTool, MCPToolCallResult } from './types';

export class SearxngMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private childPid: number | null = null;
  private tools = new Map<string, MCPTool>();

  constructor(private readonly config: MCPConfig) {}

  private get isConnected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.warn('[SearxngMcpClient] Already connected, disconnecting first...');
      await this.disconnect();
    }

    const config = this.config;
    const packageName = config.server.package || 'mcp-searxng';

    try {
      // Reclaim any subtree leaked by a previous SIGKILL'd bot before spawning
      // a fresh one (see reapOrphanedMcpChildren for why).
      reapOrphanedMcpChildren(packageName);

      const { command, args } = this.getRuntimeCommand(config.server.runtime, packageName);

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

      if (config.searxng.proxy?.http) {
        env.HTTP_PROXY = config.searxng.proxy.http;
      }
      if (config.searxng.proxy?.https) {
        env.HTTPS_PROXY = config.searxng.proxy.https;
      }

      logger.debug(`[SearxngMcpClient] Connecting to MCP server: ${command} ${args.join(' ')}`);

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

      // `bunx -y <pkg>` spawns a subtree the SDK's close() does not fully
      // reap. Track the root pid so the bot can kill the whole tree
      // deterministically on shutdown instead of leaking it to init.
      this.childPid = this.transport.pid;
      if (this.childPid != null) {
        registerMcpChild(this.childPid);
      }

      for (const tool of await this.listTools()) {
        this.tools.set(tool.name, tool);
      }

      logger.info(`[SearxngMcpClient] Connected with ${this.tools.size} tools`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('[SearxngMcpClient] Failed to connect:', err);
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.close();
      logger.info('[SearxngMcpClient] Disconnected');
    } catch (error) {
      logger.warn('[SearxngMcpClient] Error during disconnect:', error);
    }

    // SDK close() only signals the direct child (bunx); kill the full subtree
    // so the node grandchild cannot survive as an orphan.
    if (this.childPid != null) {
      await killMcpChild(this.childPid);
      this.childPid = null;
    }
    this.client = null;
    this.transport = null;
    this.tools.clear();
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<MCPToolCallResult> {
    if (!this.client) {
      throw new Error('SearxngMcpClient not connected');
    }

    try {
      logger.debug(`[SearxngMcpClient] Calling tool: ${name} with arguments:`, arguments_);
      const result = await this.client.callTool({
        name,
        arguments: arguments_,
      });

      return {
        content: (result.content || []) as MCPToolCallResult['content'],
        isError: (result.isError ?? false) as boolean,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[SearxngMcpClient] Failed to call tool ${name}:`, err);
      throw err;
    }
  }

  private async listTools(): Promise<MCPTool[]> {
    if (!this.client) {
      throw new Error('SearxngMcpClient not connected');
    }

    const tools = await this.client.listTools();
    return tools.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as MCPTool['inputSchema'],
    }));
  }

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
}
