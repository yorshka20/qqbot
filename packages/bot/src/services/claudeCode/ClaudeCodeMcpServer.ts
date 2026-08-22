/**
 * ClaudeCodeMcpServer — exposes bot capabilities to the spawned `claude` CLI
 * as MCP tools over Streamable HTTP.
 *
 * ## Multi-session architecture
 *
 * The MCP SDK's `WebStandardStreamableHTTPServerTransport` is a
 * **single-session** transport — one transport instance supports exactly one
 * client connection, and a second `initialize` on the same transport returns
 * 400 "Server already initialized". Concurrent Claude Code tasks each get
 * their own CLI process and therefore their own session, so transports are
 * created per `initialize` and routed afterwards by `Mcp-Session-Id`.
 *
 * ## Task identification
 *
 * Every request from a task's CLI carries `X-Task-Id: <taskId>`, injected via
 * the generated `--mcp-config` file (see `ClaudeToolManager.writeMcpConfig`).
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
import type { ClaudeCodeServiceConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
import { getRepoRoot } from '@/utils/repoRoot';
import type {
  BotInfo,
  ExecuteCommandParams,
  ExecuteCommandResult,
  SendMessageParams,
  TaskNotification,
  ToolDefinition,
  ToolExecuteParams,
  ToolExecuteResult,
  ToolParameter,
} from './types';

type TaskNotificationHandler = (notification: TaskNotification) => void;
type SendMessageHandler = (
  params: SendMessageParams,
) => Promise<{ success: boolean; messageId?: string; error?: string }>;
type GetBotInfoHandler = () => BotInfo;
type ExecuteCommandHandler = (params: ExecuteCommandParams) => Promise<ExecuteCommandResult>;
type ExecuteToolHandler = (params: ToolExecuteParams) => Promise<ToolExecuteResult>;
type ListToolsHandler = () => ToolDefinition[];

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
const MCP_INSTRUCTIONS_PATH = 'prompts/claude-code/mcp-instructions.md';

function loadMcpInstructions(): string {
  const path = resolvePath(getRepoRoot(), MCP_INSTRUCTIONS_PATH);
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    logger.warn(
      `[ClaudeCodeMcpServer] Could not load MCP instructions from ${path} (${err instanceof Error ? err.message : String(err)}). Using fallback string.`,
    );
    return 'You are running a Claude Code task for a chat bot. Use the bot_* tools to report progress and message the requester.';
  }
}

/**
 * Translate a `ToolDefinition` parameter into a Zod schema.
 *
 * Note the array case: `ToolParameter.enum` constrains the *elements* when
 * `type` is `array` (e.g. `quality_check.checks`), not the value itself.
 */
function toZodSchema(param: ToolParameter): z.ZodTypeAny {
  const enumValues = param.enum?.length ? (param.enum as [string, ...string[]]) : null;

  let schema: z.ZodTypeAny;
  switch (param.type) {
    case 'string':
      schema = enumValues ? z.enum(enumValues) : z.string();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'array':
      schema = z.array(enumValues ? z.enum(enumValues) : z.string());
      break;
    case 'object':
      schema = z.record(z.string(), z.unknown());
      break;
  }

  schema = schema.describe(param.description);
  return param.required ? schema : schema.optional();
}

/**
 * MCP has no `examples` / `whenToUse` fields, so fold them into the
 * description — that guidance previously lived in the prompt template's
 * reference block and would otherwise be lost.
 */
function buildToolDescription(def: ToolDefinition): string {
  const parts = [def.description];
  if (def.whenToUse) {
    parts.push(`\n\nWhen to use: ${def.whenToUse}`);
  }
  if (def.examples?.length) {
    parts.push(`\n\nExamples:\n${def.examples.map((e) => `- ${e}`).join('\n')}`);
  }
  return parts.join('');
}

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export class ClaudeCodeMcpServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, SessionEntry>();
  private readonly instructions: string;

  private onTaskNotification: TaskNotificationHandler | null = null;
  private onSendMessage: SendMessageHandler | null = null;
  private onGetBotInfo: GetBotInfoHandler | null = null;
  private onExecuteCommand: ExecuteCommandHandler | null = null;
  private onExecuteTool: ExecuteToolHandler | null = null;
  private onListTools: ListToolsHandler | null = null;

  constructor(private readonly config: ClaudeCodeServiceConfig) {
    this.instructions = loadMcpInstructions();
  }

  setTaskNotificationHandler(handler: TaskNotificationHandler): void {
    this.onTaskNotification = handler;
  }

  setSendMessageHandler(handler: SendMessageHandler): void {
    this.onSendMessage = handler;
  }

  setBotInfoHandler(handler: GetBotInfoHandler): void {
    this.onGetBotInfo = handler;
  }

  setExecuteCommandHandler(handler: ExecuteCommandHandler): void {
    this.onExecuteCommand = handler;
  }

  setExecuteToolHandler(handler: ExecuteToolHandler): void {
    this.onExecuteTool = handler;
  }

  setListToolsHandler(handler: ListToolsHandler): void {
    this.onListTools = handler;
  }

  async start(): Promise<string> {
    const host = this.config.host || '127.0.0.1';
    const port = this.config.port;

    this.httpServer = Bun.serve({
      port,
      hostname: host,
      fetch: (req) => this.handleRequest(req),
    });

    const baseUrl = `http://${host}:${port}`;
    logger.info(`[ClaudeCodeMcpServer] Started on ${baseUrl} — MCP endpoint at ${baseUrl}/mcp`);
    return baseUrl;
  }

  async stop(): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      try {
        await entry.server.close();
      } catch (err) {
        logger.warn(`[ClaudeCodeMcpServer] Error closing session ${sessionId} (non-fatal):`, err);
      }
    }
    this.sessions.clear();

    if (this.httpServer) {
      this.httpServer.stop();
      this.httpServer = null;
      logger.info('[ClaudeCodeMcpServer] Stopped');
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
      try {
        const sessionId = req.headers.get('mcp-session-id');
        const existing = sessionId ? this.sessions.get(sessionId) : undefined;
        if (existing) {
          return existing.transport.handleRequest(req);
        }
        return await this.createSessionAndHandle(req);
      } catch (err) {
        logger.error('[ClaudeCodeMcpServer] Request error:', err);
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
      { name: 'qqbot-claude-code', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: this.instructions },
    );

    this.registerTools(server);
    await server.connect(transport);

    const response = await transport.handleRequest(req);

    if (capturedSessionId) {
      this.sessions.set(capturedSessionId, { transport, server });
      logger.debug(`[ClaudeCodeMcpServer] New session ${capturedSessionId} (${this.sessions.size} active sessions)`);
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
          'Report progress on the task you are running back to the bot, which relays it to the user who ' +
          'requested it. Call this when you start, at meaningful milestones, and on completion or failure. ' +
          'The task ID is taken from your MCP connection — you do not pass it.',
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
          'Send a chat message through the bot to a user or group. Use this to talk to the person who ' +
          'requested the task — anything you print to stdout is only visible in the final task result.',
        inputSchema: {
          targetType: z.enum(['user', 'group']).describe('Whether to message a user directly or a group.'),
          targetId: z.string().describe('The user ID or group ID to send to.'),
          content: z.string().describe('Message text to send.'),
          replyTo: z.string().optional().describe('ID of a message to reply to, if threading a reply.'),
        },
      },
      async (args) => {
        if (!this.onSendMessage) {
          return this.errorResult('No send message handler registered');
        }
        const result = await this.onSendMessage({
          target: { type: args.targetType as 'user' | 'group', id: String(args.targetId) },
          content: String(args.content),
          ...(args.replyTo ? { replyTo: String(args.replyTo) } : {}),
        });
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'send failed');
      },
    );

    register(
      'bot_info',
      {
        description:
          'Get the bot runtime status: which IM protocols are connected, its own ID, uptime, and how many ' +
          'Claude Code tasks are pending or running.',
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
          '`status` returns current runtime state.',
        inputSchema: {
          command: z.enum(['restart', 'reload-plugins', 'status']).describe('Which maintenance command to run.'),
          args: z.array(z.string()).optional().describe('Extra arguments for the command.'),
        },
      },
      async (args) => {
        if (!this.onExecuteCommand) {
          return this.errorResult('No command handler registered');
        }
        const result = await this.onExecuteCommand(args as unknown as ExecuteCommandParams);
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'command failed');
      },
    );

    // The bot-side tool executors (git_commit, quality_check, …) become
    // first-class MCP tools rather than arguments to a dispatch endpoint, so
    // the CLI discovers them through the protocol's own tools/list.
    for (const def of this.onListTools?.() ?? []) {
      const inputSchema: Record<string, z.ZodTypeAny> = {};
      for (const [name, param] of Object.entries(def.parameters)) {
        inputSchema[name] = toZodSchema(param);
      }

      register(def.name, { description: buildToolDescription(def), inputSchema }, async (args, extra) => {
        if (!this.onExecuteTool) {
          return this.errorResult('No tool executor registered');
        }
        const taskId = this.extractTaskId(extra);
        const result = await this.onExecuteTool({
          tool: def.name,
          parameters: args,
          ...(taskId ? { taskId } : {}),
        });
        return result.success ? this.jsonResult(result) : this.errorResult(result.error ?? 'tool failed');
      });
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

  private jsonResult(payload: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  private errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
