/**
 * HubMCPServer — exposes ContextHub methods as MCP tools over HTTP.
 *
 * Wraps `@modelcontextprotocol/sdk`'s high-level `McpServer` and the
 * Bun-compatible `WebStandardStreamableHTTPServerTransport` to give cluster
 * workers a real MCP endpoint at `/mcp` on the same Bun.serve instance the
 * REST API uses.
 *
 * ## Why this exists
 *
 * Pre-Phase-2 the `ContextHub` had a set of custom `/hub/*` REST stubs
 * (sync / claim / report / ask / message / dispatch / directive) that no
 * worker actually called — `WorkerPool.generateMCPConfig()` was writing
 * an MCP config file but the spawned worker binaries never received the
 * `--mcp-config` flag, and even if they had, the hub didn't speak MCP at
 * the URL they would have connected to.
 *
 * Phase 2 closed both gaps:
 *
 *   1. Hub speaks MCP Streamable HTTP at `/mcp`
 *   2. Workers' MCP config points to `http://hub-host:hub-port/mcp`
 *   3. Each backend (claude/codex/gemini/minimax) wires that config into
 *      its native CLI invocation
 *
 * Batch 15 deleted the dead `/hub/*` REST stubs entirely. ContextHub now
 * only speaks `/mcp`.
 *
 * ## Worker identification
 *
 * Every MCP HTTP request from a worker carries the static header
 * `X-Worker-Id: <workerId>`, which we set in
 * `WorkerPool.generateMCPConfig()`. The MCP SDK exposes the original HTTP
 * request via `RequestHandlerExtra.requestInfo.headers`, so each tool
 * handler can read the workerId directly with no session-table bookkeeping.
 *
 * If the header is missing (e.g. someone curls `/mcp` manually), the tool
 * returns an `isError: true` payload instead of crashing — the worker can
 * surface this to the LLM as a tool error.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger } from '@/utils/logger';
import type {
  HubAskInput,
  HubClaimInput,
  HubDirectiveInput,
  HubDispatchInput,
  HubMessageInput,
  HubQueryTaskInput,
  HubReportInput,
  HubSpawnInput,
  HubWaitTaskInput,
} from '../types';
import type { ContextHub } from './ContextHub';

/** Shape of the `extra` parameter we care about — narrowed from the SDK type. */
interface ToolExtra {
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined>;
  };
  sessionId?: string;
}

/**
 * Relative path (from project cwd) to the MCP server `instructions` field
 * content. This is the worker-facing description of the cluster MCP toolbox
 * — it shows up when the LLM client first connects to /mcp and lists the
 * server's purpose. Kept in a file so it can be edited as prose without a
 * code change, mirroring how role system prompts live in
 * `prompts/cluster/<role>-system.md`.
 */
const HUB_MCP_INSTRUCTIONS_PATH = 'prompts/cluster/hub-mcp-instructions.md';

/**
 * Sync-load the MCP server instructions text. Called exactly once at
 * HubMCPServer construction. Falls back to a minimal one-line hint if the
 * file is missing so cluster start doesn't break — same degradation policy
 * as the role prompt loaders in WorkerPool.
 */
function loadHubMcpInstructions(): string {
  const path = resolvePath(process.cwd(), HUB_MCP_INSTRUCTIONS_PATH);
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    logger.warn(
      `[HubMCPServer] Could not load MCP instructions from ${path} (${err instanceof Error ? err.message : String(err)}). Using fallback string.`,
    );
    return 'You are a worker in an Agent Cluster. Use the hub_* MCP tools to coordinate with the hub.';
  }
}

/**
 * Non-generic shape for `McpServer.registerTool`. We deliberately erase the
 * SDK's `registerTool<OutputArgs, InputArgs>` generics — chained 7 times in
 * one file (one per hub tool), the SDK's `ToolCallback<Args>` /
 * `SchemaOutput<Args>` recursive instantiation balloons tsc heap usage past
 * 4 GB and OOMs. Since every handler in this file already casts `args` to a
 * concrete `HubXxxInput` internally, we don't need the inferred shape — a
 * plain `Record<string, unknown>` callback signature is sufficient.
 *
 * Runtime is unchanged: the SDK still receives the Zod shape and validates
 * input via `safeParseAsync` exactly as before. This cast only affects what
 * the type checker has to instantiate.
 */
type RegisterToolFn = (
  name: string,
  config: {
    description: string;
    inputSchema?: Record<string, z.ZodTypeAny>;
  },
  handler: (args: Record<string, unknown>, extra: ToolExtra) => Promise<CallToolResult>,
) => void;

export class HubMCPServer {
  private readonly mcpServer: McpServer;
  private readonly transport: WebStandardStreamableHTTPServerTransport;
  private connected = false;

  constructor(private readonly hub: ContextHub) {
    this.mcpServer = new McpServer(
      { name: 'cluster-context-hub', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        // Loaded from prompts/cluster/hub-mcp-instructions.md so the
        // worker-facing description of the cluster MCP toolbox stays
        // editable as content rather than buried in TS string literals.
        // Sync read because the constructor itself is sync; happens once
        // per cluster start. Falls back to a minimal hardcoded line if
        // the file is missing — better than refusing to construct.
        instructions: loadHubMcpInstructions(),
      },
    );

    this.transport = new WebStandardStreamableHTTPServerTransport({
      // Stateful: each worker MCP client gets its own session ID. We don't
      // actually need the session table for routing (we use X-Worker-Id from
      // request headers), but stateful mode is required by the SDK to support
      // long-lived MCP clients that send multiple tool calls per session.
      sessionIdGenerator: () => randomUUID(),
      // JSON response mode keeps wire protocol simple — no SSE, request goes
      // in, response comes back. Avoids the complexity of streaming for
      // tool calls that are inherently request/response anyway.
      enableJsonResponse: true,
    });

    this.registerTools();
  }

  /**
   * Start the MCP server. Idempotent. Must be called after construction
   * but before the hub Bun.serve starts accepting requests, so by the time
   * a worker connects the transport is ready.
   */
  async start(): Promise<void> {
    if (this.connected) return;
    await this.mcpServer.connect(this.transport);
    this.connected = true;
    logger.info('[HubMCPServer] Connected — 10 tools registered, ready at /mcp');
  }

  /**
   * Tear down the server (closes the underlying transport, ending any
   * in-flight sessions). Called from `ContextHub.stop()`.
   */
  async stop(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.mcpServer.close();
    } catch (err) {
      logger.warn('[HubMCPServer] Error closing MCP server (non-fatal):', err);
    }
    this.connected = false;
  }

  /**
   * Delegate an HTTP request to the underlying transport. Called from
   * `ContextHub.handleRequest()` for any URL under `/mcp`.
   */
  async handleRequest(req: Request): Promise<Response> {
    return this.transport.handleRequest(req);
  }

  // ── Tool registration ──

  private registerTools(): void {
    // Bind registerTool through the non-generic `RegisterToolFn` shape so
    // tsc instantiates the SDK's recursive `ToolCallback<Args>` exactly
    // once for the whole file instead of seven times — see RegisterToolFn
    // doc comment for the full story.
    const register = this.mcpServer.registerTool.bind(this.mcpServer) as unknown as RegisterToolFn;

    // hub_sync — no input. Pulls events / messages / directives since the
    // worker's last cursor and renews the worker's locks as a side effect.
    register(
      'hub_sync',
      {
        description:
          'Sync events from the cluster hub since your last cursor. Returns new events from other workers, ' +
          'pending messages directed at you, and any directives from the planner. Call regularly (every few ' +
          'minutes) to stay coordinated.',
        inputSchema: {},
      },
      async (_args, extra) => this.runTool('hub_sync', extra, (workerId) => this.hub.handleSync(workerId)),
    );

    // hub_claim — acquire file locks before editing.
    register(
      'hub_claim',
      {
        description:
          'Acquire exclusive locks on a set of files before editing them. Returns granted=false with the ' +
          'list of conflicting files (and their current holders) if any of the requested files are already ' +
          'locked by another worker. Always claim before writing.',
        inputSchema: {
          taskId: z.string().describe('Your current task ID (from CLUSTER_TASK_ID env var).'),
          intent: z.string().describe('One-sentence description of what you intend to do with the files.'),
          files: z.array(z.string()).describe('Absolute or repo-relative file paths to lock.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_claim', extra, (workerId) =>
          this.hub.handleClaim(workerId, args as unknown as HubClaimInput),
        ),
    );

    // hub_report — progress / completion / failure / blocked status.
    register(
      'hub_report',
      {
        description:
          'Report your task progress to the hub. Use status="working" for in-progress checkpoints, ' +
          '"completed" / "failed" / "blocked" for terminal states. Reports release locks on terminal status.',
        inputSchema: {
          status: z.enum(['working', 'completed', 'failed', 'blocked']).describe('Current task status.'),
          summary: z.string().describe('Short summary of what just happened.'),
          filesModified: z
            .array(z.string())
            .optional()
            .describe('List of files you modified during this report period.'),
          detail: z
            .object({
              linesAdded: z.number().optional(),
              linesRemoved: z.number().optional(),
              testsRan: z.number().optional(),
              testsPassed: z.number().optional(),
              error: z.string().optional(),
              blockReason: z.string().optional(),
            })
            .optional(),
        },
      },
      async (args, extra) =>
        this.runTool('hub_report', extra, (workerId) =>
          this.hub.handleReport(workerId, args as unknown as HubReportInput),
        ),
    );

    // hub_ask — escalate to a human via the planner / WebUI.
    register(
      'hub_ask',
      {
        description:
          'Ask a question that requires human judgment (clarification, decision between options, conflict ' +
          'resolution, escalation). Hub returns askId immediately and routes the question to the WebUI / QQ ' +
          'owner. The answer arrives later as a message in your next hub_sync poll.',
        inputSchema: {
          type: z.enum(['clarification', 'decision', 'conflict', 'escalation']).describe('What kind of help you need.'),
          question: z.string().describe('The question itself, written for a human reader.'),
          context: z.string().optional().describe('Background context the human will need to answer.'),
          options: z
            .array(z.string())
            .optional()
            .describe('If type=decision, list the options the human should choose between.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_ask', extra, (workerId) => this.hub.handleAsk(workerId, args as unknown as HubAskInput)),
    );

    // hub_message — send a message to another worker (or "all").
    register(
      'hub_message',
      {
        description:
          'Send a free-form message to another worker, or to "all" to broadcast. Use sparingly — most ' +
          'coordination should go through hub_sync events and hub_claim locks. Reserved for cases where you ' +
          'need to nudge a peer about something time-sensitive.',
        inputSchema: {
          to: z.string().describe('Target workerId, or "all" to broadcast to every active worker.'),
          content: z.string().describe('The message body.'),
          priority: z.enum(['info', 'warning']).describe('Message priority.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_message', extra, (workerId) =>
          this.hub.handleMessage(workerId, args as unknown as HubMessageInput),
        ),
    );

    // hub_dispatch — planner-only: queue a new task for a coder worker.
    register(
      'hub_dispatch',
      {
        description:
          'PLANNER ONLY. Queue a new task for a coder worker. The hub schedules it through the normal ' +
          'task pipeline, picking the worker template from your hint or the project default.',
        inputSchema: {
          project: z.string().describe('Target project alias.'),
          taskDescription: z.string().describe('Full task description for the coder worker.'),
          files: z.array(z.string()).describe('Files the coder is expected to touch (used for upfront locking).'),
          workerTemplate: z.string().optional().describe('Override the project default workerPreference.'),
          priority: z.number().optional().describe('Higher numbers run first within the same scheduling tick.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_dispatch', extra, async (workerId) =>
          this.hub.handleDispatch(workerId, args as unknown as HubDispatchInput),
        ),
    );

    // hub_directive — planner-only: push an instruction into a worker's
    // message box, delivered as a directive on its next hub_sync.
    register(
      'hub_directive',
      {
        description:
          'PLANNER ONLY. Send a directive to a specific coder worker. The directive arrives as a message in ' +
          "the worker's next hub_sync poll, marked with high priority.",
        inputSchema: {
          to: z.string().describe('Target workerId.'),
          content: z.string().describe('The directive text.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_directive', extra, (workerId) =>
          this.hub.handleDirective(workerId, args as unknown as HubDirectiveInput),
        ),
    );

    // ── Phase 3 multi-agent: planner-only spawn / query / wait ──
    //
    // These three tools let a planner worker create executor children, poll
    // their status, and block on completion. The role gate (planner-only)
    // is enforced inside ContextHub — calling them as an executor will throw
    // and the runTool wrapper turns the throw into an `isError: true`
    // tool result that the LLM sees as a tool error.

    // hub_spawn — planner creates a child executor task.
    register(
      'hub_spawn',
      {
        description:
          'PLANNER ONLY. Spawn a child executor worker to handle a subtask. You must pick the executor template ' +
          'explicitly (e.g. "claude-sonnet-executor", "minimax-executor"). Returns childTaskId — pass it to ' +
          'hub_query_task / hub_wait_task to monitor the child. You can NOT spawn another planner; the role ' +
          'argument, if given, must be "executor". One layer of decomposition only.',
        inputSchema: {
          description: z
            .string()
            .describe('Full prompt the executor will receive (include goal/context/acceptance criteria).'),
          template: z.string().describe('Worker template name from cluster config — required, no fallback.'),
          role: z
            .enum(['executor'])
            .optional()
            .describe('Optional; only "executor" is allowed. Nested planners are forbidden.'),
          capabilities: z.array(z.string()).optional().describe('Optional capability hints (informational).'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_spawn', extra, (workerId) =>
          this.hub.handleSpawn(workerId, args as unknown as HubSpawnInput),
        ),
    );

    // hub_query_task — planner non-blocking status check on a child.
    register(
      'hub_query_task',
      {
        description:
          'PLANNER ONLY. Non-blocking snapshot of a child task you previously spawned. Returns status / output / ' +
          'error / timestamps. You can only query tasks that are direct children of your current task — querying ' +
          "another worker's tasks is rejected. Use hub_wait_task if you want to block until the child terminates.",
        inputSchema: {
          taskId: z.string().describe('childTaskId returned by hub_spawn.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_query_task', extra, (workerId) =>
          this.hub.handleQueryTask(workerId, args as unknown as HubQueryTaskInput),
        ),
    );

    // hub_wait_task — planner blocking wait, polls handleQueryTask internally.
    register(
      'hub_wait_task',
      {
        description:
          'PLANNER ONLY. Block until a child task you spawned reaches a terminal status (completed/failed) or ' +
          'the timeout elapses. Internally polls hub_query_task every 500ms. Default timeout 600000ms (10 min); ' +
          'hub clamps to a 30-min hard cap. Same security check as hub_query_task: child must belong to you.',
        inputSchema: {
          taskId: z.string().describe('childTaskId returned by hub_spawn.'),
          timeoutMs: z.number().optional().describe('Max wait in milliseconds. Default 600000. Hard max 1800000.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_wait_task', extra, (workerId) =>
          this.hub.handleWaitTask(workerId, args as unknown as HubWaitTaskInput),
        ),
    );
  }

  // ── Helpers ──

  /**
   * Common wrapper for tool handlers: extract workerId, run the body
   * (which may be sync or async), serialize the result. Centralized so
   * every tool handles missing-header / thrown-error cases the same way.
   */
  private async runTool(
    toolName: string,
    extra: unknown,
    body: (workerId: string) => unknown | Promise<unknown>,
  ): Promise<CallToolResult> {
    const workerId = this.extractWorkerId(extra as ToolExtra);
    if (!workerId) {
      logger.warn(`[HubMCPServer] ${toolName}: missing X-Worker-Id header`);
      return this.errorResult(
        'Missing X-Worker-Id header. Your MCP client config must set headers["X-Worker-Id"] to your worker ID.',
      );
    }
    try {
      const result = await body(workerId);
      return this.jsonResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[HubMCPServer] ${toolName} (worker=${workerId}) threw:`, err);
      return this.errorResult(`hub method threw: ${message}`);
    }
  }

  /**
   * Read the worker ID from the original HTTP request's headers. The MCP
   * SDK normalizes header names to lowercase per HTTP convention.
   */
  private extractWorkerId(extra: ToolExtra): string | null {
    const h = extra?.requestInfo?.headers;
    if (!h) return null;
    const raw = h['x-worker-id'];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string' && raw[0].trim()) {
      return raw[0].trim();
    }
    return null;
  }

  private jsonResult(data: unknown): CallToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    };
  }

  private errorResult(message: string): CallToolResult {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }
}
