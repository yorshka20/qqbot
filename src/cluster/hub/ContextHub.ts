/**
 * ContextHub — central communication hub for the Agent Cluster.
 *
 * Runs as an HTTP server inside the QQ Bot process.
 * Exposes MCP tool endpoints: hub_sync, hub_claim, hub_report, hub_ask, hub_message.
 * Also hub_dispatch and hub_directive for planner workers.
 */

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';
import type { ClusterConfig } from '../config';
import type {
  ClusterEventType,
  HelpRequest,
  HubAskInput,
  HubAskOutput,
  HubClaimInput,
  HubClaimOutput,
  HubDirectiveInput,
  HubDispatchInput,
  HubMessageInput,
  HubMessageOutput,
  HubReportInput,
  HubReportOutput,
  HubSyncOutput,
  HubUpdate,
  TaskCandidate,
} from '../types';
import { EventLog } from './EventLog';
import { HubMCPServer } from './HubMCPServer';
import { LockManager } from './LockManager';
import { MessageBox } from './MessageBox';
import { WorkerRegistry } from './WorkerRegistry';

/** Callback for when planner dispatches a new task */
export type DispatchCallback = (candidate: TaskCandidate) => Promise<void>;

/**
 * Callback fired when a worker reports a terminal task status via
 * `hub_report`. Fires BEFORE the worker process exits — the LLM
 * voluntarily declaring "I'm done" rather than the kernel telling us
 * via exit code. `ClusterManager` wires this to
 * `ClusterScheduler.markTaskCompleted` so WebUI/SSE/DB see the new
 * status immediately instead of waiting for the process teardown to
 * propagate through `WorkerPool.monitorProcess`.
 *
 * Implementations must be tolerant of `taskId` being `undefined` (worker
 * didn't know its taskId for some reason) or stale (task already removed
 * from activeTasks). Never throws — errors are caught by the caller.
 */
export type ReportCallback = (
  workerId: string,
  taskId: string | undefined,
  input: HubReportInput,
) => void | Promise<void>;

/** SSE subscriber for real-time event streaming */
export interface SSESubscriber {
  send(event: string, data: unknown): void;
  close(): void;
}

export class ContextHub {
  readonly eventLog: EventLog;
  readonly lockManager: LockManager;
  readonly messageBox: MessageBox;
  readonly workerRegistry: WorkerRegistry;
  /**
   * MCP server for worker tool calls. Mounted at `/mcp` on the same Bun.serve
   * instance that hosts the REST API. Workers' MCP clients connect here via
   * the config file written by `WorkerPool.generateMCPConfig()`.
   */
  readonly mcpServer: HubMCPServer;

  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private dispatchCallback: DispatchCallback | null = null;
  private reportCallback: ReportCallback | null = null;
  private sseSubscribers = new Set<SSESubscriber>();
  private helpRequests = new Map<string, HelpRequest>();

  constructor(
    private config: ClusterConfig,
    private db: Database,
  ) {
    this.eventLog = new EventLog(db, config.hub.eventLogMaxSize);
    this.lockManager = new LockManager(db, this.eventLog, config.hub.lockTTL);
    this.messageBox = new MessageBox();
    this.workerRegistry = new WorkerRegistry();
    this.mcpServer = new HubMCPServer(this);

    this.loadHelpRequests();
  }

  /**
   * Set callback for planner dispatch requests.
   */
  setDispatchCallback(cb: DispatchCallback): void {
    this.dispatchCallback = cb;
  }

  /**
   * Set callback for worker report events. `ClusterManager` wires this
   * to `ClusterScheduler.markTaskCompleted` so terminal statuses flow
   * straight to DB / job counters instead of waiting for process exit.
   * See `ReportCallback` doc comment for the full rationale.
   */
  setReportCallback(cb: ReportCallback): void {
    this.reportCallback = cb;
  }

  /**
   * Start the HTTP server. The MCP server is connected first so the
   * `/mcp` route is ready to accept requests the moment Bun.serve is up.
   */
  async start(): Promise<string> {
    const { port, host } = this.config.hub;

    // Start MCP first so /mcp handler is ready before bind.
    await this.mcpServer.start();

    this.httpServer = Bun.serve({
      port,
      hostname: host,
      // MCP clients (claude's streamable HTTP transport in particular) keep
      // HTTP keep-alive connections open across tool calls. The default Bun
      // idleTimeout of 10s prints a "request timed out" warning whenever
      // there's a gap that long between calls, which is false noise — the
      // connection is fine, just idle. Bump to 255s (Bun's max) to silence it
      // without disabling timeouts entirely.
      idleTimeout: 255,
      fetch: (req) => this.handleRequest(req),
    });

    const url = `http://${host}:${port}`;
    logger.info(`[ContextHub] Started on ${url} (REST + /mcp)`);
    return url;
  }

  /**
   * Stop the hub. MCP server is closed AFTER the HTTP server so any
   * in-flight tool calls have a chance to drain.
   */
  async stop(): Promise<void> {
    this.lockManager.stop();
    if (this.httpServer) {
      this.httpServer.stop();
      this.httpServer = null;
    }
    await this.mcpServer.stop();
    // Close all SSE connections
    for (const sub of this.sseSubscribers) {
      sub.close();
    }
    this.sseSubscribers.clear();
    logger.info('[ContextHub] Stopped');
  }

  /**
   * Notify hub that a worker process has exited (called by WorkerPool).
   */
  workerExited(workerId: string): void {
    this.lockManager.releaseAll(workerId);
    this.workerRegistry.markExited(workerId);
    this.eventLog.append('worker_left', workerId, {});
    this.broadcastSSE('worker_status', { workerId, status: 'exited' });
  }

  // ── MCP Tool implementations ──

  handleSync(workerId: string): HubSyncOutput {
    // Ensure worker is registered
    const reg = this.workerRegistry.register(workerId, {});
    const cursor = reg.syncCursor;

    // Get events since cursor
    const { events, compactedSummary } = this.eventLog.getAfter(cursor, workerId);

    // Get pending messages
    const messageUpdates = this.messageBox.consume(workerId);

    // Convert events to updates
    const eventUpdates: HubUpdate[] = events.map((e) => ({
      type: e.type,
      from: e.sourceWorkerId,
      summary: this.summarizeEvent(e.type, e.data),
      data: e.data,
    }));

    // Update cursor
    const newCursor = events.length > 0 ? events[events.length - 1].seq : cursor;
    this.workerRegistry.updateCursor(workerId, newCursor);

    // Renew locks
    this.lockManager.renewAll(workerId);

    const updates = [...eventUpdates, ...messageUpdates];
    if (compactedSummary) {
      updates.unshift({
        type: 'message' as ClusterEventType,
        from: 'hub',
        summary: compactedSummary,
      });
    }

    return {
      updates,
      cluster: {
        activeWorkers: this.workerRegistry.getActiveCount(),
        pendingTasks: 0, // Will be filled by scheduler
        myPendingMessages: this.messageBox.getUnreadCount(workerId),
      },
    };
  }

  handleClaim(workerId: string, input: HubClaimInput): HubClaimOutput {
    this.workerRegistry.touch(workerId);
    this.workerRegistry.setTask(workerId, input.taskId);

    const result = this.lockManager.tryAcquire(input.files, workerId, input.taskId);

    if (result.granted) {
      this.eventLog.append(
        'lock_acquired',
        workerId,
        {
          intent: input.intent,
          files: input.files,
        },
        { taskId: input.taskId },
      );
    }

    return {
      granted: result.granted,
      conflicts: result.conflicts.length > 0 ? result.conflicts : undefined,
      suggestion: result.conflicts.length > 0 ? '建议先处理不涉及冲突文件的部分，稍后重试 claim' : undefined,
    };
  }

  handleReport(workerId: string, input: HubReportInput): HubReportOutput {
    this.workerRegistry.touch(workerId);
    this.workerRegistry.incrementStat(workerId, 'totalReports');

    const isTerminal = input.status === 'completed' || input.status === 'failed' || input.status === 'blocked';

    // Snapshot the taskId up front. The registration object is mutated
    // by `setTask(workerId, undefined)` further down in the terminal path,
    // and since `reg` is a reference, any later `reg?.currentTaskId` reads
    // would see undefined. Capture it into a local now.
    const reg = this.workerRegistry.get(workerId);
    const taskIdSnapshot = reg?.currentTaskId;

    // Record event
    const eventType: ClusterEventType =
      input.status === 'completed' ? 'task_completed' : input.status === 'failed' ? 'task_failed' : 'file_changed';
    this.eventLog.append(
      eventType,
      workerId,
      {
        status: input.status,
        summary: input.summary,
        filesModified: input.filesModified,
        detail: input.detail,
      },
      { taskId: taskIdSnapshot },
    );

    // Update stats
    if (input.status === 'completed') {
      this.workerRegistry.incrementStat(workerId, 'tasksCompleted');
    } else if (input.status === 'failed') {
      this.workerRegistry.incrementStat(workerId, 'tasksFailed');
    }

    // Release locks on terminal status
    if (isTerminal) {
      this.lockManager.releaseAll(workerId);
      this.workerRegistry.setTask(workerId, undefined);
    } else {
      // Renew locks for non-terminal reports
      this.lockManager.renewAll(workerId);
    }

    // Get pending directives
    const directives = this.messageBox.getUnreadDirectives(workerId);

    // Broadcast SSE
    this.broadcastSSE('worker_status', {
      workerId,
      status: input.status,
      summary: input.summary,
      taskId: taskIdSnapshot,
    });

    // Notify the scheduler so terminal statuses propagate to DB / job
    // counters / activeTasks immediately — without this, the worker exit
    // path (WorkerPool.monitorProcess → taskCompletedCallback) is the only
    // way scheduler state advances, which means WebUI shows "running" for
    // tasks the LLM has already marked done. Fire-and-forget so report()
    // never blocks on scheduler internals; `markTaskCompleted` is already
    // idempotent against the later exit-code path.
    //
    // We only fire for `completed` and `failed`. `blocked` means the
    // worker is still alive waiting for intervention, so the task is not
    // terminal from the scheduler's POV; `working` is obviously not
    // terminal either.
    if (this.reportCallback && (input.status === 'completed' || input.status === 'failed')) {
      Promise.resolve(this.reportCallback(workerId, taskIdSnapshot, input)).catch((err) => {
        logger.error(`[ContextHub] reportCallback threw (worker=${workerId}, status=${input.status}):`, err);
      });
    }

    return {
      ack: true,
      directives: directives.length > 0 ? directives : undefined,
    };
  }

  handleAsk(workerId: string, input: HubAskInput): HubAskOutput {
    this.workerRegistry.touch(workerId);
    const reg = this.workerRegistry.get(workerId);

    const askId = randomUUID();
    const helpRequest: HelpRequest = {
      id: askId,
      workerId,
      taskId: reg?.currentTaskId,
      type: input.type,
      question: input.question,
      context: input.context,
      options: input.options,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.helpRequests.set(askId, helpRequest);
    this.persistHelpRequest(helpRequest);

    // Record event
    this.eventLog.append(
      'help_request',
      workerId,
      {
        askId,
        type: input.type,
        question: input.question,
      },
      { taskId: reg?.currentTaskId },
    );

    // Broadcast SSE for WebUI
    this.broadcastSSE('help_request', {
      askId,
      workerId,
      type: input.type,
      question: input.question,
      options: input.options,
    });

    return {
      received: true,
      askId,
      expectedResponseTime: 'planner 通常 1-2 分钟内回复',
    };
  }

  handleMessage(workerId: string, input: HubMessageInput): HubMessageOutput {
    this.workerRegistry.touch(workerId);

    if (input.to === 'all') {
      // Broadcast to all active workers
      for (const w of this.workerRegistry.getActive()) {
        if (w.workerId !== workerId) {
          this.messageBox.send(w.workerId, workerId, input.content, 'message', input.priority);
        }
      }
    } else {
      this.messageBox.send(input.to, workerId, input.content, 'message', input.priority);
    }

    this.eventLog.append('message', workerId, {
      to: input.to,
      content: input.content,
      priority: input.priority,
    });

    return { delivered: true };
  }

  // ── Planner-only tools ──

  async handleDispatch(workerId: string, input: HubDispatchInput): Promise<{ dispatched: boolean }> {
    if (!this.dispatchCallback) {
      logger.warn('[ContextHub] Dispatch requested but no callback set');
      return { dispatched: false };
    }

    const candidate: TaskCandidate = {
      description: input.taskDescription,
      source: 'planner',
      project: input.project,
      files: input.files,
      priority: input.priority,
      metadata: { dispatchedBy: workerId, workerTemplate: input.workerTemplate },
    };

    await this.dispatchCallback(candidate);
    return { dispatched: true };
  }

  handleDirective(_workerId: string, input: HubDirectiveInput): { sent: boolean } {
    this.messageBox.send(input.to, 'planner', input.content, 'directive', 'warning');
    return { sent: true };
  }

  // ── Help request management ──

  answerHelpRequest(askId: string, answer: string, answeredBy: string): boolean {
    const request = this.helpRequests.get(askId);
    if (!request || request.status !== 'pending') return false;

    request.status = 'answered';
    request.answer = answer;
    request.answeredBy = answeredBy;
    request.answeredAt = new Date().toISOString();
    this.persistHelpRequest(request);

    // Send answer to worker
    this.messageBox.send(request.workerId, answeredBy, answer, 'answer');

    return true;
  }

  getPendingHelpRequests(): HelpRequest[] {
    return Array.from(this.helpRequests.values()).filter((r) => r.status === 'pending');
  }

  // ── SSE ──

  addSSESubscriber(subscriber: SSESubscriber): void {
    this.sseSubscribers.add(subscriber);
  }

  removeSSESubscriber(subscriber: SSESubscriber): void {
    this.sseSubscribers.delete(subscriber);
  }

  private broadcastSSE(event: string, data: unknown): void {
    for (const sub of this.sseSubscribers) {
      try {
        sub.send(event, data);
      } catch {
        this.sseSubscribers.delete(sub);
      }
    }
  }

  // ── HTTP handler ──

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Id',
      'Content-Type': 'application/json',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    try {
      // Route /mcp/* to the MCP server (worker tool calls). This must come
      // BEFORE the REST API check so the MCP transport gets full control
      // of its endpoint and can handle GET (SSE), POST (tool calls), and
      // DELETE (session termination).
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        return this.mcpServer.handleRequest(req);
      }

      // /api/cluster/* used to be handled here too, but the WebUI never
      // hit ContextHub directly — it always goes through StaticServer's
      // ClusterAPIBackend. ContextHub now only serves /mcp (worker MCP)
      // and /hub/* (legacy worker REST endpoints below).

      // Extract worker ID from header
      const workerId = req.headers.get('X-Worker-Id') || 'unknown';

      // MCP tool endpoints
      if (req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;

        switch (path) {
          case '/hub/sync':
            return Response.json(this.handleSync(workerId), { headers });

          case '/hub/claim':
            return Response.json(this.handleClaim(workerId, body as unknown as HubClaimInput), { headers });

          case '/hub/report':
            return Response.json(this.handleReport(workerId, body as unknown as HubReportInput), { headers });

          case '/hub/ask':
            return Response.json(this.handleAsk(workerId, body as unknown as HubAskInput), { headers });

          case '/hub/message':
            return Response.json(this.handleMessage(workerId, body as unknown as HubMessageInput), { headers });

          case '/hub/dispatch':
            return Response.json(await this.handleDispatch(workerId, body as unknown as HubDispatchInput), { headers });

          case '/hub/directive':
            return Response.json(this.handleDirective(workerId, body as unknown as HubDirectiveInput), { headers });
        }
      }

      // Query endpoints (for WebUI / debugging)
      if (req.method === 'GET') {
        switch (path) {
          case '/hub/status':
            return Response.json(
              {
                activeWorkers: this.workerRegistry.getActiveCount(),
                workers: this.workerRegistry.getAll(),
                locks: this.lockManager.getActiveLocks(),
                pendingHelp: this.getPendingHelpRequests().length,
              },
              { headers },
            );

          case '/hub/events': {
            const limit = parseInt(url.searchParams.get('limit') || '50', 10);
            const offset = parseInt(url.searchParams.get('offset') || '0', 10);
            return Response.json(this.eventLog.query({ limit, offset }), { headers });
          }

          case '/hub/locks':
            return Response.json(this.lockManager.getActiveLocks(), { headers });

          case '/hub/help':
            return Response.json(this.getPendingHelpRequests(), { headers });
        }
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers });
    } catch (err) {
      logger.error('[ContextHub] Request error:', err);
      return Response.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500, headers });
    }
  }

  // ── Helpers ──

  private summarizeEvent(type: ClusterEventType, data: Record<string, unknown>): string {
    switch (type) {
      case 'file_changed':
        return `修改了文件: ${(data.filesModified as string[] | undefined)?.join(', ') || '(unknown)'}`;
      case 'task_completed':
        return `任务完成: ${data.summary || ''}`;
      case 'task_failed':
        return `任务失败: ${data.summary || ''}`;
      case 'lock_acquired':
        return `锁定文件: ${(data.files as string[] | undefined)?.join(', ') || data.file || ''}`;
      case 'lock_released':
        return `释放文件锁: ${data.file || ''}`;
      case 'worker_joined':
        return '新 worker 加入';
      case 'worker_left':
        return 'worker 退出';
      case 'help_request':
        return `请求帮助: ${data.question || ''}`;
      default:
        return `${type}: ${JSON.stringify(data).slice(0, 100)}`;
    }
  }

  private loadHelpRequests(): void {
    try {
      const rows = this.db.query("SELECT * FROM cluster_help_requests WHERE status = 'pending'").all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const request: HelpRequest = {
          id: row.id as string,
          workerId: row.workerId as string,
          taskId: row.taskId as string | undefined,
          type: row.type as HelpRequest['type'],
          question: row.question as string,
          context: row.context as string | undefined,
          options: row.options ? JSON.parse(row.options as string) : undefined,
          status: row.status as HelpRequest['status'],
          answer: row.answer as string | undefined,
          answeredBy: row.answeredBy as string | undefined,
          createdAt: row.createdAt as string,
          answeredAt: row.answeredAt as string | undefined,
        };
        this.helpRequests.set(request.id, request);
      }
    } catch {
      // Table may not exist yet
    }
  }

  private persistHelpRequest(request: HelpRequest): void {
    try {
      this.db
        .query(
          `INSERT OR REPLACE INTO cluster_help_requests
         (id, workerId, taskId, type, question, context, options, status, answer, answeredBy, createdAt, answeredAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          request.workerId,
          request.taskId ?? null,
          request.type,
          request.question,
          request.context ?? null,
          request.options ? JSON.stringify(request.options) : null,
          request.status,
          request.answer ?? null,
          request.answeredBy ?? null,
          request.createdAt,
          request.answeredAt ?? null,
        );
    } catch (err) {
      logger.error('[ContextHub] Failed to persist help request:', err);
    }
  }
}
