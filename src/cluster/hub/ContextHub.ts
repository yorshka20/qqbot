/**
 * ContextHub — central communication hub for the Agent Cluster.
 *
 * Runs an HTTP server inside the QQ Bot process. The only HTTP route is
 * `/mcp`, served by `HubMCPServer` over the MCP Streamable HTTP transport.
 * Workers connect via the MCP config file written by
 * `WorkerPool.generateMCPConfig()`.
 *
 * MCP tools exposed:
 *   - Common (any role):
 *       hub_sync   — poll events / messages / directives since last cursor
 *       hub_claim  — acquire file locks before editing
 *       hub_report — report progress / completion / failure / blocked
 *       hub_ask    — escalate to a human (decision / clarification / ...)
 *       hub_message — message another worker
 *   - Planner-only (Phase 2):
 *       hub_dispatch  — queue a new task (legacy; use hub_spawn for Phase 3)
 *       hub_directive — push an instruction into a worker's message box
 *   - Planner-only (Phase 3 multi-agent):
 *       hub_spawn      — spawn a child executor worker for a subtask
 *       hub_query_task — non-blocking snapshot of a child task
 *       hub_wait_task  — block until a child reaches terminal status
 *
 * The Phase 1 `/hub/*` REST stubs were removed in batch 15. The WebUI
 * never connected to ContextHub directly — it has always gone through
 * StaticServer's ClusterAPIBackend.
 */

import type { Database } from 'bun:sqlite';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
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
  HubQueryTaskInput,
  HubQueryTaskOutput,
  HubReportInput,
  HubReportOutput,
  HubSpawnInput,
  HubSpawnOutput,
  HubSyncOutput,
  HubUpdate,
  HubWaitTaskInput,
  TaskCandidate,
  TaskRecord,
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

/** Called after every successful hub_report so WorkerPool can refresh lastReport (stuck detection). */
export type HeartbeatCallback = (workerId: string) => void;

/** SSE subscriber for real-time event streaming */
export interface SSESubscriber {
  send(event: string, data: unknown): void;
  close(): void;
}

/**
 * Phase 3 multi-agent: minimal interface ContextHub uses to talk back to
 * ClusterScheduler when handling planner-only tools (`hub_spawn`,
 * `hub_query_task`, `hub_wait_task`). Defined as an interface (not a direct
 * scheduler import) so the hub stays decoupled from the scheduler module
 * graph and can be wired in unit tests with a stub.
 *
 * Wired by `ClusterManager` in its constructor via `setSchedulerBridge()`.
 * If unset, all three planner tools return an error indicating cluster
 * misconfiguration — the cluster will still run, executor-only flows are
 * unaffected.
 */
export interface SchedulerBridge {
  submitChildTask(opts: {
    parentTaskId: string;
    parentJobId: string;
    project: string;
    description: string;
    template: string;
  }): Promise<TaskRecord | null>;
  findTask(taskId: string): TaskRecord | undefined;
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
  private heartbeatCallback: HeartbeatCallback | null = null;
  private schedulerBridge: SchedulerBridge | null = null;
  private sseSubscribers = new Set<SSESubscriber>();
  private helpRequests = new Map<string, HelpRequest>();

  constructor(
    private config: ClusterConfig,
    private db: Database,
  ) {
    this.eventLog = new EventLog(db, config.hub.eventLogMaxSize);
    this.lockManager = new LockManager(db, this.eventLog, config.hub.lockTTL);
    this.messageBox = new MessageBox();
    this.workerRegistry = new WorkerRegistry(db);
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
   * Wire `WorkerPool.updateLastReport` (or equivalent) so every hub_report
   * resets the stuck-worker timer.
   */
  setHeartbeatCallback(cb: HeartbeatCallback): void {
    this.heartbeatCallback = cb;
  }

  /**
   * Phase 3: wire the scheduler bridge so planner-only tools (`hub_spawn`,
   * `hub_query_task`, `hub_wait_task`) can submit children and look up
   * task records. Without this, those three tools return an error to the
   * planner. Set once at cluster construction time.
   */
  setSchedulerBridge(bridge: SchedulerBridge): void {
    this.schedulerBridge = bridge;
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
   * Cleans up MCP session so the next worker can connect without hitting
   * "Server already initialized".
   */
  workerExited(workerId: string): void {
    this.lockManager.releaseAll(workerId);
    this.workerRegistry.markExited(workerId);
    this.eventLog.append('worker_left', workerId, {});
    this.broadcastSSE('worker_status', { workerId, status: 'exited' });
    // Clean up the worker's MCP session (fire-and-forget).
    void this.mcpServer.closeWorkerSession(workerId);
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
    this.workerRegistry.register(workerId, {});
    this.workerRegistry.incrementStat(workerId, 'totalReports');
    this.workerRegistry.recordHubReport(workerId, {
      summary: input.summary,
      nextSteps: input.nextSteps,
      status: input.status,
    });

    const isTerminal = input.status === 'completed' || input.status === 'failed' || input.status === 'blocked';

    // Snapshot the taskId up front. The registration object is mutated
    // by `setTask(workerId, undefined)` further down in the terminal path,
    // and since `reg` is a reference, any later `reg?.currentTaskId` reads
    // would see undefined. Capture it into a local now.
    const reg = this.workerRegistry.get(workerId);
    const taskIdSnapshot = reg?.currentTaskId;

    // Record event — dedicated types for progress vs terminal outcomes.
    let eventType: ClusterEventType;
    if (input.status === 'completed') {
      eventType = 'task_completed';
    } else if (input.status === 'failed') {
      eventType = 'task_failed';
    } else if (input.status === 'blocked') {
      eventType = 'task_blocked';
    } else {
      eventType = 'worker_progress';
    }
    this.eventLog.append(
      eventType,
      workerId,
      {
        status: input.status,
        summary: input.summary,
        nextSteps: input.nextSteps,
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
      nextSteps: input.nextSteps,
      taskId: taskIdSnapshot,
    });

    if (this.heartbeatCallback) {
      try {
        this.heartbeatCallback(workerId);
      } catch (err) {
        logger.error(`[ContextHub] heartbeatCallback threw (worker=${workerId}):`, err);
      }
    }

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

  // ── Phase 3 multi-agent: planner spawn / query / wait ──

  /**
   * Hub side of `hub_spawn`. Validates the calling worker is a planner with
   * a live current task, then asks the scheduler to create + dispatch a
   * child task. Throws on any precondition failure — the MCP runTool
   * wrapper turns thrown errors into `isError: true` tool results that the
   * LLM sees as a tool error message.
   *
   * Safety rules:
   *   1. Caller must be `role === 'planner'` (executors get a hard reject).
   *   2. Caller must have a `currentTaskId` (the parent for the spawn).
   *   3. `input.role`, if specified, must be `'executor'` — nested planners
   *      are explicitly forbidden (one-layer rule, see Phase 3 design doc).
   *   4. Scheduler bridge must be wired (otherwise cluster misconfig).
   */
  async handleSpawn(workerId: string, input: HubSpawnInput): Promise<HubSpawnOutput> {
    this.workerRegistry.touch(workerId);
    const reg = this.workerRegistry.get(workerId);
    if (!reg || reg.role !== 'planner') {
      throw new Error('hub_spawn is only available to planner-role workers');
    }
    if (input.role && input.role !== 'executor') {
      throw new Error('hub_spawn cannot create planner-role workers (one-layer rule)');
    }
    const parentTaskId = reg.currentTaskId;
    if (!parentTaskId) {
      throw new Error('hub_spawn: planner has no current task to be a parent of');
    }
    if (!this.schedulerBridge) {
      throw new Error('hub_spawn: scheduler bridge not wired (cluster misconfiguration)');
    }
    const parent = this.schedulerBridge.findTask(parentTaskId);
    if (!parent) {
      throw new Error(`hub_spawn: parent task ${parentTaskId} not found in scheduler`);
    }
    const child = await this.schedulerBridge.submitChildTask({
      parentTaskId,
      parentJobId: parent.jobId,
      project: parent.project,
      description: input.description,
      template: input.template,
    });
    if (!child) {
      throw new Error(
        `hub_spawn: scheduler refused to create child task (unknown template "${input.template}" or unknown project)`,
      );
    }

    // Broadcast so WebUI can show planner's decomposed sub-tasks in real time
    this.broadcastSSE('task_spawned', {
      taskId: child.id,
      parentTaskId,
      parentWorkerId: workerId,
      project: parent.project,
      jobId: parent.jobId,
      template: input.template,
      description: input.description,
      status: child.status === 'running' ? 'running' : 'queued',
    });

    return {
      childTaskId: child.id,
      // tryDispatch sets status='running' on successful immediate spawn,
      // leaves it as 'pending' if the pool was full.
      status: child.status === 'running' ? 'running' : 'queued',
    };
  }

  /**
   * Hub side of `hub_query_task`. Returns a snapshot of one task's state.
   * Security check: the caller (planner) must be the parent of the task it
   * is asking about — otherwise a planner could enumerate / spy on tasks
   * across the whole cluster.
   *
   * Returns a snapshot even after the task is terminal: scheduler.findTask
   * falls back to a DB read so a planner can poll children that have
   * already been removed from the in-memory active map.
   */
  handleQueryTask(workerId: string, input: HubQueryTaskInput): HubQueryTaskOutput {
    this.workerRegistry.touch(workerId);
    const reg = this.workerRegistry.get(workerId);
    if (!reg || reg.role !== 'planner') {
      throw new Error('hub_query_task is only available to planner-role workers');
    }
    if (!this.schedulerBridge) {
      throw new Error('hub_query_task: scheduler bridge not wired');
    }
    const target = this.schedulerBridge.findTask(input.taskId);
    if (!target) {
      throw new Error(`hub_query_task: task ${input.taskId} not found`);
    }
    if (target.parentTaskId !== reg.currentTaskId) {
      // Don't leak whether a non-child task exists; both "not yours" and
      // "not exists" should look the same from the planner's POV.
      throw new Error(`hub_query_task: task ${input.taskId} is not a child of your current task`);
    }
    return {
      taskId: target.id,
      status: target.status,
      workerId: target.workerId,
      output: target.output,
      error: target.error,
      startedAt: target.startedAt,
      completedAt: target.completedAt,
    };
  }

  /**
   * Hub side of `hub_wait_task`. Polls `handleQueryTask` every 500ms until
   * the target task reaches a terminal status (`completed` / `failed`) or
   * the timeout elapses. Returns the same shape as `hub_query_task`.
   *
   * Implementation note: this blocks the MCP request handler (which is
   * fine — MCP tool calls are inherently long-running and the SSE
   * framing overhead per response is negligible). The hub
   * itself is single-process; other workers' tool calls run in parallel
   * because Bun.serve fetch handlers are independent async closures.
   *
   * Timeout is clamped to a hard upper bound of 30 minutes regardless of
   * what the planner asks for — keeps a misbehaving planner from leaking
   * Bun.serve fetch handlers indefinitely if it picks Number.MAX_SAFE_INTEGER.
   */
  async handleWaitTask(workerId: string, input: HubWaitTaskInput): Promise<HubQueryTaskOutput> {
    const HARD_MAX_MS = 30 * 60_000;
    const requestedTimeout = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : 600_000;
    const timeoutMs = Math.min(requestedTimeout, HARD_MAX_MS);
    const deadline = Date.now() + timeoutMs;
    const POLL_INTERVAL_MS = 5_000;

    // Keep the planner's heartbeat alive while we block here. Without this
    // the planner has no chance to call hub_report (its MCP call is in
    // flight) and no stdout activity, so healthCheck would kill it.
    const HEARTBEAT_INTERVAL_MS = 60_000;
    let lastHeartbeat = Date.now();

    // Use handleQueryTask for consistency: same auth checks, same shape.
    while (true) {
      const snapshot = this.handleQueryTask(workerId, { taskId: input.taskId });
      if (snapshot.status === 'completed' || snapshot.status === 'failed') {
        return snapshot;
      }
      if (Date.now() >= deadline) {
        // Return the latest non-terminal snapshot — planner can decide
        // whether to retry, escalate, or give up. Don't throw on timeout
        // because the task hasn't actually failed; it's just taking long.
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      // Refresh heartbeat every minute so the planner isn't killed for being "stuck".
      const now = Date.now();
      if (this.heartbeatCallback && now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeat = now;
        try {
          this.heartbeatCallback(workerId);
        } catch {
          // Non-fatal — heartbeat callback shouldn't throw, but don't let it break the wait loop.
        }
      }
    }
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

  /**
   * Broadcast intermediate worker output via SSE so the WebUI can show
   * live progress. Called from ClusterManager's taskProgressCallback.
   */
  broadcastTaskOutput(taskId: string, workerId: string | undefined, output: string | undefined): void {
    if (!output) return;
    this.broadcastSSE('task_output', { taskId, workerId, output });
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

  /**
   * The hub's Bun.serve fetch handler. After Phase 2 (MCP wiring) the
   * **only** route this server speaks is `/mcp`. All worker coordination
   * goes through the MCP transport — the Phase 1 `/hub/*` REST stubs
   * (sync / claim / report / ask / message / dispatch / directive +
   * GET status/events/locks/help) were dead code from before MCP shipped
   * and got removed in batch 15. The WebUI never hit ContextHub directly;
   * it has always gone through StaticServer's ClusterAPIBackend.
   *
   * Anything that isn't `/mcp` returns 404 — workers shouldn't see it
   * unless something is misconfigured, in which case the 404 is the
   * fastest way to surface the problem.
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers — only used for the 404 / OPTIONS path now; the MCP
    // transport sets its own headers.
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
      // Route /mcp/* to the MCP server (worker tool calls). The MCP
      // transport handles GET (SSE), POST (tool calls), and DELETE
      // (session termination) on its own.
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        return this.mcpServer.handleRequest(req);
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
      case 'worker_progress':
        return `进展: ${data.summary || ''}${data.nextSteps ? ` → 下一步: ${data.nextSteps}` : ''}`;
      case 'task_completed':
        return `任务完成: ${data.summary || ''}`;
      case 'task_failed':
        return `任务失败: ${data.summary || ''}`;
      case 'task_blocked':
        return `阻塞: ${data.summary || ''}`;
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
      // Mark all previously-pending help requests as expired. On restart
      // the workers that created them are gone, so these requests are
      // stale and should not trigger new QQ notifications.
      const expired = this.db
        .query("UPDATE cluster_help_requests SET status = 'expired' WHERE status = 'pending' RETURNING id")
        .all() as Array<Record<string, unknown>>;

      if (expired.length > 0) {
        logger.info(`[ContextHub] Expired ${expired.length} stale pending help request(s) from previous session`);
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
