/**
 * CodingAgentMcpServer — exposes bot capabilities to the spawned coding-agent
 * CLI (claude or codex) as MCP tools over Streamable HTTP.
 *
 * ## Multi-session architecture
 *
 * The MCP SDK's `WebStandardStreamableHTTPServerTransport` is a
 * **single-session** transport — one transport instance supports exactly one
 * client connection, and a second `initialize` on the same transport returns
 * 400 "Server already initialized". Concurrent agent tasks each get
 * their own CLI process and therefore their own session, so transports are
 * created per `initialize` and routed afterwards by `Mcp-Session-Id`.
 *
 * ## Task identification
 *
 * Every request from a task's CLI carries `X-Task-Id: <taskId>`, which each
 * executor injects into its CLI's MCP client config (see `executors/`).
 * Tools read it from `extra.requestInfo.headers` rather than taking it as an
 * argument, so the model cannot report progress against the wrong task.
 *
 * ## No authentication
 *
 * Deliberate: this endpoint binds to the IM host's LAN address because QQ
 * allows only one logged-in host and LAN clients must reach it, and the
 * deployment is a trusted private network. Do not add ambient-authority
 * capabilities here without revisiting that assumption.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolDefinition } from '@/ai/types';
import type { CodingAgentConfig } from '@/core/config';
import { CARD_DECK_DESCRIPTION } from '@/services/card/cardTypes';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
import { getRepoRoot } from '@/utils/repoRoot';
import type { BotInfo, ExecuteCommandParams, ExecuteCommandResult, TaskNotification } from './types';

type TaskNotificationHandler = (notification: TaskNotification) => void;
type DeliveryResult = { success: boolean; messageId?: string; error?: string };
type SendMessageHandler = (taskId: string, content: string) => Promise<DeliveryResult>;
type SendCardHandler = (taskId: string, cards: unknown[]) => Promise<DeliveryResult>;
type SendFileHandler = (taskId: string, path: string, fileName: string | undefined) => Promise<DeliveryResult>;
type GetBotInfoHandler = () => BotInfo;
type ExecuteCommandHandler = (taskId: string, params: ExecuteCommandParams) => Promise<ExecuteCommandResult>;
type TaskActivityHandler = (taskId: string) => void;

/** Bot tools offered to agents (see AgentToolBridge); the list is read once per MCP session. */
export interface BotToolProvider {
  list(): ToolDefinition[];
  call(taskId: string, name: string, parameters: Record<string, unknown>): Promise<{ success: boolean; reply: string }>;
}

/**
 * Tool definitions carry JSON Schema; the MCP SDK takes a Zod shape. Bot tool
 * parameters only use flat types, so array items and object fields are left
 * for the tool's own validation.
 */
export function toZodShape(parameters: ToolDefinition['parameters']): Record<string, z.ZodTypeAny> {
  const required = new Set(parameters.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, property] of Object.entries(parameters.properties)) {
    let schema: z.ZodTypeAny;
    if (property.enum && property.enum.length > 0) {
      schema = z.enum(property.enum as [string, ...string[]]);
    } else if (property.type === 'number' || property.type === 'integer') {
      schema = z.number();
    } else if (property.type === 'boolean') {
      schema = z.boolean();
    } else if (property.type === 'array') {
      schema = z.array(z.unknown());
    } else if (property.type === 'object') {
      schema = z.record(z.string(), z.unknown());
    } else {
      schema = z.string();
    }
    if (property.description) {
      schema = schema.describe(property.description);
    }
    shape[name] = required.has(name) ? schema : schema.optional();
  }
  return shape;
}

/** Shape of the `extra` parameter we care about — narrowed from the SDK type. */
interface ToolExtra {
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

/**
 * Non-generic shape for `McpServer.registerTool`. The SDK's
 * `registerTool<OutputArgs, InputArgs>` generics balloon tsc heap usage when
 * chained once per tool in a single file — `HubMCPServer` hit a >4 GB OOM at
 * seven call sites and uses the same cast. Runtime is unchanged: the SDK still
 * receives the Zod shape and validates via `safeParseAsync`.
 */
type RegisterToolFn = (
  name: string,
  config: {
    description: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
  },
  handler: (args: Record<string, unknown>, extra: ToolExtra) => Promise<CallToolResult>,
) => void;

/**
 * Worker-facing prose describing this toolbox, surfaced as the MCP server's
 * `instructions`. Kept in a file so it can be edited without a code change,
 * mirroring `prompts/cluster/hub-mcp-instructions.md`.
 */
const MCP_INSTRUCTIONS_PATH = 'prompts/coding-agent/mcp-instructions.md';

function loadMcpInstructions(): string {
  const path = resolvePath(getRepoRoot(), MCP_INSTRUCTIONS_PATH);
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    logger.warn(
      `[CodingAgentMcpServer] Could not load MCP instructions from ${path} (${err instanceof Error ? err.message : String(err)}). Using fallback string.`,
    );
    return 'You are running a coding task for a chat bot. Use the bot_* tools to report progress and message the requester.';
  }
}

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export class CodingAgentMcpServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, SessionEntry>();
  private readonly instructions: string;

  private onTaskNotification: TaskNotificationHandler | null = null;
  private onSendMessage: SendMessageHandler | null = null;
  private onSendCard: SendCardHandler | null = null;
  private onSendFile: SendFileHandler | null = null;
  private onGetBotInfo: GetBotInfoHandler | null = null;
  private onExecuteCommand: ExecuteCommandHandler | null = null;
  private onTaskActivity: TaskActivityHandler | null = null;
  private botTools: BotToolProvider | null = null;

  constructor(private readonly config: CodingAgentConfig) {
    this.instructions = loadMcpInstructions();
  }

  setTaskNotificationHandler(handler: TaskNotificationHandler): void {
    this.onTaskNotification = handler;
  }

  setSendMessageHandler(handler: SendMessageHandler): void {
    this.onSendMessage = handler;
  }

  setSendCardHandler(handler: SendCardHandler): void {
    this.onSendCard = handler;
  }

  setSendFileHandler(handler: SendFileHandler): void {
    this.onSendFile = handler;
  }

  setBotInfoHandler(handler: GetBotInfoHandler): void {
    this.onGetBotInfo = handler;
  }

  setExecuteCommandHandler(handler: ExecuteCommandHandler): void {
    this.onExecuteCommand = handler;
  }

  setBotToolProvider(provider: BotToolProvider): void {
    this.botTools = provider;
  }

  /** Called for every MCP request that carries an `X-Task-Id` — the task is alive. */
  setTaskActivityHandler(handler: TaskActivityHandler): void {
    this.onTaskActivity = handler;
  }

  async start(): Promise<string> {
    const host = this.config.host || '127.0.0.1';
    const port = this.config.port;

    this.httpServer = Bun.serve({
      port,
      hostname: host,
      // MCP clients keep keep-alive connections open between tool calls, and
      // an agent can go minutes between calls. Bun's default 10s idleTimeout
      // then logs a "timed out a request" warning for every such gap; 255s is
      // Bun's maximum.
      idleTimeout: 255,
      fetch: (req) => this.handleRequest(req),
    });

    const baseUrl = `http://${host}:${port}`;
    logger.info(`[CodingAgentMcpServer] Started on ${baseUrl} — MCP endpoint at ${baseUrl}/mcp`);
    return baseUrl;
  }

  async stop(): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      try {
        await entry.server.close();
      } catch (err) {
        logger.warn(`[CodingAgentMcpServer] Error closing session ${sessionId} (non-fatal):`, err);
      }
    }
    this.sessions.clear();

    if (this.httpServer) {
      this.httpServer.stop();
      this.httpServer = null;
      logger.info('[CodingAgentMcpServer] Stopped');
    }
  }

  getUrl(): string {
    return `http://${this.config.host || '127.0.0.1'}:${this.config.port}`;
  }

  getMcpUrl(): string {
    return `${this.getUrl()}/mcp`;
  }

  // ── HTTP routing ──

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', sessions: this.sessions.size });
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      const taskId = req.headers.get('x-task-id');
      if (taskId) {
        this.onTaskActivity?.(taskId);
      }
      try {
        const sessionId = req.headers.get('mcp-session-id');
        const existing = sessionId ? this.sessions.get(sessionId) : undefined;
        if (existing) {
          return existing.transport.handleRequest(req);
        }
        return await this.createSessionAndHandle(req);
      } catch (err) {
        logger.error('[CodingAgentMcpServer] Request error:', err);
        return Response.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 });
      }
    }

    return Response.json({ error: 'Not Found — this server speaks MCP at /mcp' }, { status: 404 });
  }

  private async createSessionAndHandle(req: Request): Promise<Response> {
    let capturedSessionId: string | null = null;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        capturedSessionId = randomUUID();
        return capturedSessionId;
      },
      onsessioninitialized: (sid: string) => {
        capturedSessionId = sid;
      },
    });

    const server = new McpServer(
      { name: 'qqbot-coding-agent', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: this.instructions },
    );

    this.registerTools(server);
    await server.connect(transport);

    const response = await transport.handleRequest(req);

    if (capturedSessionId) {
      this.sessions.set(capturedSessionId, { transport, server });
      logger.debug(`[CodingAgentMcpServer] New session ${capturedSessionId} (${this.sessions.size} active sessions)`);
    }

    return response;
  }

  // ── Tool registration ──

  private registerTools(mcpServer: McpServer): void {
    const register = mcpServer.registerTool.bind(mcpServer) as unknown as RegisterToolFn;

    register(
      'bot_notify_task',
      {
        description:
          'Report progress on the task you are running; the bot relays each report with a message to the ' +
          "requester's chat immediately. Call it with status=started once you understand the task and with " +
          'status=progress at meaningful milestones. Your final answer is your last output and is delivered on ' +
          'exit, so status=completed is not needed. The task ID is taken from your MCP connection — you do not pass it.',
        inputSchema: {
          status: z.enum(['started', 'progress', 'completed', 'failed']).describe('Lifecycle state being reported.'),
          message: z.string().optional().describe('Short human-readable status line for the requester.'),
          progress: z.number().optional().describe('Completion percentage, 0-100.'),
          result: z.string().optional().describe('Final result summary. Use with status=completed.'),
          error: z.string().optional().describe('Failure reason. Use with status=failed.'),
        },
      },
      async (args, extra) => {
        const taskId = this.extractTaskId(extra);
        if (!taskId) {
          return this.errorResult('Missing X-Task-Id header. Your MCP client config must set headers["X-Task-Id"].');
        }
        if (!this.onTaskNotification) {
          return this.errorResult('No task notification handler registered');
        }
        this.onTaskNotification({ taskId, ...args } as unknown as TaskNotification);
        return this.jsonResult({
          success: true,
          message: `Task ${taskId} status updated to: ${String(args.status)}`,
        });
      },
    );

    register(
      'bot_send_message',
      {
        description:
          'Send a chat message to the person who requested the task, in the chat they asked from. Use it for ' +
          'anything they should see before the task ends; your final output is delivered on its own.',
        inputSchema: {
          content: z.string().describe('Message text to send. Plain text — QQ does not render Markdown.'),
        },
      },
      async (args, extra) => {
        const taskId = this.extractTaskId(extra);
        if (!taskId) {
          return this.errorResult('Missing X-Task-Id header. Your MCP client config must set headers["X-Task-Id"].');
        }
        if (!this.onSendMessage) {
          return this.errorResult('No send message handler registered');
        }
        const result = await this.onSendMessage(taskId, String(args.content));
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'send failed');
      },
    );

    register(
      'bot_send_card',
      {
        description:
          'Render structured content (lists, steps, comparisons, key conclusions, markdown) as a card image and ' +
          'send it to the requester. Use it for a long or structured report instead of a wall of text.',
        inputSchema: {
          cards: z.array(z.record(z.string(), z.unknown())).describe(CARD_DECK_DESCRIPTION),
        },
      },
      async (args, extra) => {
        const taskId = this.extractTaskId(extra);
        if (!taskId) {
          return this.errorResult('Missing X-Task-Id header. Your MCP client config must set headers["X-Task-Id"].');
        }
        if (!this.onSendCard) {
          return this.errorResult('No send card handler registered');
        }
        const result = await this.onSendCard(taskId, args.cards as unknown[]);
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'send failed');
      },
    );

    register(
      'bot_send_file',
      {
        description:
          'Upload a file from your task workspace and send it to the requester. Only files inside the workspace ' +
          'can be sent; pack a directory into an archive (e.g. `zip -r out.zip dir`) first.',
        inputSchema: {
          path: z.string().describe('File path, absolute or relative to your workspace.'),
          fileName: z.string().optional().describe('Name to show in chat. Defaults to the file name.'),
        },
      },
      async (args, extra) => {
        const taskId = this.extractTaskId(extra);
        if (!taskId) {
          return this.errorResult('Missing X-Task-Id header. Your MCP client config must set headers["X-Task-Id"].');
        }
        if (!this.onSendFile) {
          return this.errorResult('No send file handler registered');
        }
        const fileName = typeof args.fileName === 'string' ? args.fileName : undefined;
        const result = await this.onSendFile(taskId, String(args.path), fileName);
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'send failed');
      },
    );

    register(
      'bot_info',
      {
        description:
          'Get the bot runtime status: which IM protocols are connected, its own ID, uptime, and how many ' +
          'agent tasks are pending or running.',
        inputSchema: {},
      },
      async () => {
        if (!this.onGetBotInfo) {
          return this.errorResult('No bot info handler registered');
        }
        return this.jsonResult(this.onGetBotInfo());
      },
    );

    register(
      'bot_command',
      {
        description:
          'Run a bot maintenance command. `restart` pulls code, updates dependencies and restarts the bot ' +
          '(this will kill your own task — call it last). `reload-plugins` reloads all plugins in place. ' +
          '`status` returns current runtime state. Not available to research tasks.',
        inputSchema: {
          command: z.enum(['restart', 'reload-plugins', 'status']).describe('Which maintenance command to run.'),
          args: z.array(z.string()).optional().describe('Extra arguments for the command.'),
        },
      },
      async (args, extra) => {
        const taskId = this.extractTaskId(extra);
        if (!taskId) {
          return this.errorResult('Missing X-Task-Id header. Your MCP client config must set headers["X-Task-Id"].');
        }
        if (!this.onExecuteCommand) {
          return this.errorResult('No command handler registered');
        }
        const result = await this.onExecuteCommand(taskId, args as unknown as ExecuteCommandParams);
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'command failed');
      },
    );

    for (const tool of this.botTools?.list() ?? []) {
      register(
        tool.name,
        { description: tool.description, inputSchema: toZodShape(tool.parameters) },
        async (args, extra) => {
          const taskId = this.extractTaskId(extra);
          if (!taskId) {
            return this.errorResult('Missing X-Task-Id header. Your MCP client config must set headers["X-Task-Id"].');
          }
          if (!this.botTools) {
            return this.errorResult('No bot tool provider registered');
          }
          const result = await this.botTools.call(taskId, tool.name, args);
          return result.success ? this.textResult(result.reply) : this.errorResult(result.reply);
        },
      );
    }
  }

  // ── Helpers ──

  /** The MCP SDK normalizes header names to lowercase per HTTP convention. */
  private extractTaskId(extra: ToolExtra): string | null {
    const raw = extra?.requestInfo?.headers?.['x-task-id'];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
    return null;
  }

  private textResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private jsonResult(payload: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  private errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
