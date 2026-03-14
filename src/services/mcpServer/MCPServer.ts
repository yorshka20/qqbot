/**
 * MCP Server for Claude Code integration
 *
 * This server exposes a REST API that Claude Code can call to:
 * 1. Notify the bot of task status (started, progress, completed, failed)
 * 2. Send messages to users/groups via the bot
 * 3. Query bot status and information
 *
 * Uses a simple HTTP REST API for reliability and ease of use.
 * Claude Code can use this via the WebFetch tool or curl commands.
 */

import { logger } from '@/utils/logger';
import type {
  BotInfo,
  ExecuteCommandParams,
  ExecuteCommandResult,
  MCPServerConfig,
  SendMessageParams,
  TaskNotification,
} from './types';

// Handler types
type TaskNotificationHandler = (notification: TaskNotification) => void;
type SendMessageHandler = (
  params: SendMessageParams,
) => Promise<{ success: boolean; messageId?: string; error?: string }>;
type GetBotInfoHandler = () => BotInfo;
type ExecuteCommandHandler = (params: ExecuteCommandParams) => Promise<ExecuteCommandResult>;

export class MCPServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private config: MCPServerConfig;

  // Handlers set by the bot
  private onTaskNotification: TaskNotificationHandler | null = null;
  private onSendMessage: SendMessageHandler | null = null;
  private onGetBotInfo: GetBotInfoHandler | null = null;
  private onExecuteCommand: ExecuteCommandHandler | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /**
   * Set handler for task notifications from Claude Code
   */
  setTaskNotificationHandler(handler: TaskNotificationHandler): void {
    this.onTaskNotification = handler;
  }

  /**
   * Set handler for sending messages via bot
   */
  setSendMessageHandler(handler: SendMessageHandler): void {
    this.onSendMessage = handler;
  }

  /**
   * Set handler for getting bot info
   */
  setBotInfoHandler(handler: GetBotInfoHandler): void {
    this.onGetBotInfo = handler;
  }

  /**
   * Set handler for executing bot commands
   */
  setExecuteCommandHandler(handler: ExecuteCommandHandler): void {
    this.onExecuteCommand = handler;
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<string> {
    const port = this.config.port;
    const host = this.config.host || '127.0.0.1';

    this.httpServer = Bun.serve({
      port,
      hostname: host,
      fetch: async (req) => {
        return this.handleRequest(req);
      },
    });

    const baseUrl = `http://${host}:${port}`;
    logger.info(`[MCPServer] Started on ${baseUrl}`);
    logger.info(`[MCPServer] API endpoints:`);
    logger.info(`  POST ${baseUrl}/api/notify  - Notify task status`);
    logger.info(`  POST ${baseUrl}/api/send    - Send message`);
    logger.info(`  POST ${baseUrl}/api/command - Execute bot command`);
    logger.info(`  GET  ${baseUrl}/api/info    - Get bot info`);
    return baseUrl;
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return this.jsonResponse({ status: 'ok' }, 200, corsHeaders);
    }

    // API endpoints
    try {
      // POST /api/notify - Notify task status
      if (url.pathname === '/api/notify' && req.method === 'POST') {
        const body = (await req.json()) as TaskNotification;

        if (!body.taskId || !body.status) {
          return this.jsonResponse({ error: 'Missing required fields: taskId, status' }, 400, corsHeaders);
        }

        if (this.onTaskNotification) {
          this.onTaskNotification(body);
          return this.jsonResponse(
            {
              success: true,
              message: `Task ${body.taskId} status updated to: ${body.status}`,
            },
            200,
            corsHeaders,
          );
        }
        return this.jsonResponse({ error: 'No task notification handler registered' }, 500, corsHeaders);
      }

      // POST /api/send - Send message
      if (url.pathname === '/api/send' && req.method === 'POST') {
        const body = (await req.json()) as SendMessageParams;

        if (!body.target?.type || !body.target?.id || !body.content) {
          return this.jsonResponse(
            { error: 'Missing required fields: target.type, target.id, content' },
            400,
            corsHeaders,
          );
        }

        if (this.onSendMessage) {
          const result = await this.onSendMessage(body);
          return this.jsonResponse(result, result.success ? 200 : 500, corsHeaders);
        }
        return this.jsonResponse({ error: 'No send message handler registered' }, 500, corsHeaders);
      }

      // GET /api/info - Get bot info
      if (url.pathname === '/api/info' && req.method === 'GET') {
        if (this.onGetBotInfo) {
          const info = this.onGetBotInfo();
          return this.jsonResponse(info, 200, corsHeaders);
        }
        return this.jsonResponse({ error: 'No bot info handler registered' }, 500, corsHeaders);
      }

      // POST /api/command - Execute bot command
      if (url.pathname === '/api/command' && req.method === 'POST') {
        const body = (await req.json()) as ExecuteCommandParams;

        if (!body.command) {
          return this.jsonResponse({ error: 'Missing required field: command' }, 400, corsHeaders);
        }

        const validCommands = ['restart', 'reload-plugins', 'status'];
        if (!validCommands.includes(body.command)) {
          return this.jsonResponse(
            { error: `Invalid command: ${body.command}. Valid commands: ${validCommands.join(', ')}` },
            400,
            corsHeaders,
          );
        }

        if (this.onExecuteCommand) {
          const result = await this.onExecuteCommand(body);
          return this.jsonResponse(result, result.success ? 200 : 500, corsHeaders);
        }
        return this.jsonResponse({ error: 'No command handler registered' }, 500, corsHeaders);
      }

      // API documentation
      if (url.pathname === '/' || url.pathname === '/api') {
        return this.jsonResponse(
          {
            name: 'QQBot MCP Server',
            version: '1.0.0',
            endpoints: {
              'POST /api/notify': {
                description: 'Notify the bot of Claude Code task status',
                body: {
                  taskId: 'string (required)',
                  status: 'started | progress | completed | failed (required)',
                  message: 'string (optional)',
                  progress: 'number 0-100 (optional)',
                  result: 'string (optional, for completed)',
                  error: 'string (optional, for failed)',
                },
              },
              'POST /api/send': {
                description: 'Send a message via the bot',
                body: {
                  target: {
                    type: 'user | group',
                    id: 'string (user ID or group ID)',
                  },
                  content: 'string',
                  replyTo: 'string (optional, message ID to reply to)',
                },
              },
              'GET /api/info': {
                description: 'Get current bot status and information',
              },
              'POST /api/command': {
                description: 'Execute a bot command',
                body: {
                  command: 'restart | reload-plugins | status (required)',
                  args: 'string[] (optional)',
                },
                commands: {
                  restart: 'Pull code, update dependencies, and restart the bot',
                  'reload-plugins': 'Reload all plugins',
                  status: 'Get bot status',
                },
              },
            },
          },
          200,
          corsHeaders,
        );
      }

      return this.jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
    } catch (error) {
      logger.error('[MCPServer] Request error:', error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      return this.jsonResponse({ error: message }, 500, corsHeaders);
    }
  }

  private jsonResponse(data: unknown, status: number, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    if (this.httpServer) {
      this.httpServer.stop();
      this.httpServer = null;
      logger.info('[MCPServer] Stopped');
    }
  }

  /**
   * Get the server URL
   */
  getUrl(): string {
    return `http://${this.config.host || '127.0.0.1'}:${this.config.port}`;
  }

  /**
   * Get the API base URL
   */
  getApiBaseUrl(): string {
    return `${this.getUrl()}/api`;
  }
}
