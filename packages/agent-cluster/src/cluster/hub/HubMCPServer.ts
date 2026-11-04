/**
 * HubMCPServer — exposes ContextHub methods as MCP tools over HTTP.
 *
 * ## Stateless transport
 *
 * Every request gets a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`
 * pair with all hub tools registered, and the transport issues no session id. Workers
 * outlive the scheduler (they are detached processes), and a client that holds a session
 * id from before a scheduler restart would otherwise be refused with "Server not
 * initialized": claude's MCP client does not re-initialize on that error, so the worker's
 * next tool call would simply fail. With no session state there is nothing to lose.
 *
 * ## Worker identification
 *
 * Every MCP HTTP request from a worker carries the static header
 * `X-Worker-Id: <workerId>`, set in `WorkerPool.generateMCPConfig()`; the tool handlers
 * read it from `extra.requestInfo.headers`.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getRepoRoot, logger } from '@qqbot/shared';
import { z } from 'zod';
import type {
  HubAskInput,
  HubClaimInput,
  HubDirectiveInput,
  HubDispatchInput,
  HubMessageInput,
  HubQueryTaskInput,
  HubReportInput,
  HubSpawnInput,
  HubWaitInput,
  HubWaitTaskInput,
  HubWritePlanInput,
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
 * Sync-load the MCP server instructions text. Called once at construction
 * and cached. Falls back to a minimal one-line hint if the file is missing
 * so cluster start doesn't break.
 */
function loadHubMcpInstructions(): string {
  const path = resolvePath(getRepoRoot(), HUB_MCP_INSTRUCTIONS_PATH);
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
  /** Cached MCP server instructions text (loaded once). */
  private readonly instructions: string;

  constructor(private readonly hub: ContextHub) {
    this.instructions = loadHubMcpInstructions();
  }

  async start(): Promise<void> {
    logger.info('[HubMCPServer] Ready — stateless mode, one server per request at /mcp');
  }

  async stop(): Promise<void> {
    logger.info('[HubMCPServer] Stopped');
  }

  /**
   * Serve one request with its own server + transport pair. The pair lives as long as the
   * response does (a GET keeps an SSE stream open) and is collected afterwards.
   */
  async handleRequest(req: Request): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = new McpServer(
      { name: 'cluster-context-hub', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        instructions: this.instructions,
      },
    );
    this.registerTools(server);
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  // ── Tool registration ──

  private registerTools(mcpServer: McpServer): void {
    const register = mcpServer.registerTool.bind(mcpServer) as unknown as RegisterToolFn;

    // hub_sync
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

    // hub_claim
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

    // hub_report
    register(
      'hub_report',
      {
        description:
          'Report your task progress to the hub. Use status="working" for in-progress checkpoints, ' +
          '"completed" / "failed" / "blocked" for terminal states. Reports release locks on terminal status. ' +
          'When status is "working", nextSteps is REQUIRED (what you will do next) so the hub can prove you are not stuck.',
        inputSchema: {
          status: z.enum(['working', 'completed', 'failed', 'blocked']).describe('Current task status.'),
          summary: z.string().describe('Short summary of what just happened.'),
          nextSteps: z
            .string()
            .optional()
            .describe(
              'Required when status=working: one or two sentences on what you will do before the next report. ' +
                'Optional for terminal statuses.',
            ),
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
      async (args, extra) => {
        const input = args as unknown as HubReportInput;
        if (input.status === 'working' && (!input.nextSteps || !String(input.nextSteps).trim())) {
          return this.errorResult(
            'hub_report with status="working" requires a non-empty nextSteps string (what you will do next before the next report).',
          );
        }
        return this.runTool('hub_report', extra, (workerId) => this.hub.handleReport(workerId, input));
      },
    );

    // hub_ask
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

    // hub_message
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

    // hub_dispatch — planner-only (legacy Phase 2)
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

    // hub_directive — planner-only (legacy Phase 2)
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

    // hub_spawn
    register(
      'hub_spawn',
      {
        description:
          'PLANNER ONLY. Spawn a child executor worker to handle a subtask. You must pick the executor template ' +
          'explicitly (e.g. "claude-sonnet", "minimax-m2" — must match a cluster.workerTemplates key). Returns childTaskId — pass it to ' +
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

    // hub_query_task
    register(
      'hub_query_task',
      {
        description:
          'PLANNER ONLY. Non-blocking snapshot of a child task you previously spawned. Returns status, live stdout ' +
          '(output) while running, hub_report summary (diffSummary) after completion, error, timestamps. You can ' +
          "only query tasks that are direct children of your current task — querying another worker's tasks is " +
          'rejected. Use hub_wait_task if you want to block until the child terminates.',
        inputSchema: {
          taskId: z.string().describe('childTaskId returned by hub_spawn.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_query_task', extra, (workerId) =>
          this.hub.handleQueryTask(workerId, args as unknown as HubQueryTaskInput),
        ),
    );

    // hub_wait — event-driven wait for any worker
    register(
      'hub_wait',
      {
        description:
          'Block until something you must react to happens: a child task you watch reaches a terminal status, ' +
          'a message/directive/answer arrives for you (owner messages included), or the window (max 240 s) ' +
          'runs out. Nothing polls — the hub wakes you the moment the event occurs. Use this instead of sleep ' +
          'or periodic hub_sync. reason=timeout means nothing happened: call it again.',
        inputSchema: {
          tasks: z
            .array(z.string())
            .optional()
            .describe('Child task ids to watch (planners: every child still running).'),
          timeoutMs: z.number().optional().describe('Max wait in milliseconds; capped at 240000.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_wait', extra, (workerId) => this.hub.handleWait(workerId, args as unknown as HubWaitInput)),
    );

    // hub_wait_task
    register(
      'hub_wait_task',
      {
        description:
          'PLANNER ONLY. Block until this one child task reaches a terminal status (completed/failed) or the ' +
          'window (max 240 s) runs out; the hub wakes you on the event, nothing polls. Prefer hub_wait, which ' +
          'watches several children and also wakes on messages. Same security check as hub_query_task.',
        inputSchema: {
          taskId: z.string().describe('childTaskId returned by hub_spawn.'),
          timeoutMs: z.number().optional().describe('Max wait in milliseconds; capped at 240000.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_wait_task', extra, (workerId) =>
          this.hub.handleWaitTask(workerId, args as unknown as HubWaitTaskInput),
        ),
    );

    // ── Plan artifact: planner-only ──

    // hub_write_plan
    register(
      'hub_write_plan',
      {
        description:
          'PLANNER ONLY. Persist your decomposition plan as `tickets/<ticketId>/plan.md` (the orchestrator ' +
          "derives the ticket directory from your current task's job). If a plan already exists, the old file " +
          'is archived to `tickets/<ticketId>/plan-v<N>.md` (next available N) before the new content is ' +
          'written. The orchestrator writes `content` verbatim — you own the frontmatter (including ' +
          '`plan_version`). Call this BEFORE hub_spawn for any non-trivial ticket so the plan is reviewable ' +
          'and re-runnable.',
        inputSchema: {
          content: z
            .string()
            .describe('Full plan.md content (frontmatter + body). The orchestrator writes it verbatim.'),
        },
      },
      async (args, extra) =>
        this.runTool('hub_write_plan', extra, (workerId) =>
          this.hub.handleWritePlan(workerId, args as unknown as HubWritePlanInput),
        ),
    );

    // hub_read_plan
    register(
      'hub_read_plan',
      {
        description:
          'PLANNER ONLY. Read the current `tickets/<ticketId>/plan.md` for your current task, if one exists. ' +
          'Returns `{ exists: false }` if no plan has been written yet. Use this on planner startup to check ' +
          'whether a previous planner run (or a human edit) already produced a plan you can reuse, instead of ' +
          'redoing decomposition from scratch.',
        inputSchema: {},
      },
      async (_args, extra) => this.runTool('hub_read_plan', extra, (workerId) => this.hub.handleReadPlan(workerId)),
    );
  }

  // ── Helpers ──

  /**
   * Common wrapper for tool handlers: extract workerId, run the body
   * (which may be sync or async), serialize the result.
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
