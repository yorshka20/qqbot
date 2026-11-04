/**
 * ContextHub — central communication hub for the Agent Cluster.
 *
 * Runs the cluster's one HTTP server. `/mcp` is served by `HubMCPServer` over the MCP
 * Streamable HTTP transport and accepts loopback clients only; workers connect via the
 * MCP config file written by `WorkerPool.generateMCPConfig()`. Every other path is
 * dispatched to the routes mounted with `registerRoute()` (the daemon's REST API, health
 * and static console), in registration order.
 *
 * The server can be opened by `listen()` ahead of `start()` so that it outlives
 * `start()` / `stop()` cycles of the cluster: the daemon keeps its port bound while the
 * cluster is stopped from the API. `stop()` closes the server only when `start()` opened it.
 *
 * MCP tools exposed:
 *   - Common (any role):
 *       hub_sync   — poll events / messages / directives since last cursor
 *       hub_claim  — acquire file locks before editing
 *       hub_report — report progress / completion / failure / blocked
 *       hub_ask    — escalate to a human (decision / clarification / ...)
 *       hub_message — message another worker
 *       hub_subscribe / hub_unsubscribe — choose the sibling events that wake this worker
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
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getRepoRoot, logger, randomUUID } from '@qqbot/shared';
import type { ClusterConfig } from '../config';
import { readClusterPrompt, renderPrompt } from '../prompts';
import { bucketForProject, findTicketDir, ticketDirForCreate } from '../tickets/storage';
import type {
  ClusterEventType,
  HelpRequest,
  HubAnswerInput,
  HubAnswerOutput,
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
  HubReadPlanOutput,
  HubReportInput,
  HubReportOutput,
  HubSayInput,
  HubSayOutput,
  HubSpawnInput,
  HubSpawnOutput,
  HubSubscribeInput,
  HubSubscribeOutput,
  HubSubscriptionEvent,
  HubSubscriptions,
  HubSyncOutput,
  HubTaskSnapshot,
  HubUnsubscribeInput,
  HubUnsubscribeOutput,
  HubUpdate,
  HubWaitInput,
  HubWaitOutput,
  HubWaitTaskInput,
  HubWritePlanInput,
  HubWritePlanOutput,
  TaskCandidate,
  TaskRecord,
} from '../types';
import { EventLog } from './EventLog';
import { HubMCPServer } from './HubMCPServer';
import { type LockChange, LockManager } from './LockManager';
import { MessageBox } from './MessageBox';
import { normalizeInterestPath, SubscriptionStore } from './SubscriptionStore';
import { WorkerRegistry } from './WorkerRegistry';
import { WAIT_MAX_MS } from './waitWindow';

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

/**
 * A route mounted on the hub's HTTP server beside `/mcp`: a path prefix and its handler.
 * The handler returns `null` for a path under its prefix it does not serve, which falls
 * through to a 404.
 */
export interface HubRoute {
  readonly prefix: string;
  handle(pathname: string, req: Request): Promise<Response | null> | Response | null;
}

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
    subscribe?: HubSubscribeInput;
  }): Promise<TaskRecord | null>;
  findTask(taskId: string): TaskRecord | undefined;
  /** A task has ended and its branch, if any, has landed: its status will not change again. */
  isTaskSettled(taskId: string): boolean;
}

/**
 * Longest a hub_wait blocks. Bun's HTTP idle timeout for the hub is 255 s; a response that has
 * not started by then is cut, so the window stays under it and the worker calls again.
 */
// A planner reads the tail to see what a child is doing now; the full log is the owner's, on disk.
const QUERY_OUTPUT_TAIL_CHARS = 8_000;
const WAIT_HEARTBEAT_MS = 60_000;
const MAX_EVENT_FILES = 50;
const MAX_EVENT_SUMMARY_CHARS = 300;
/** Stale by the time a worker starts, so a task still waiting for one is not told. */
const TRANSIENT_EVENTS: ReadonlySet<HubSubscriptionEvent['kind']> = new Set([
  'worker_progress',
  'lock_acquired',
  'lock_released',
]);

/** Where messages for a task wait until a worker starts on it. */
function taskInbox(taskId: string): string {
  return `task:${taskId}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_EVENT_SUMMARY_CHARS ? `${line.slice(0, MAX_EVENT_SUMMARY_CHARS)}…` : line;
}

export class ContextHub {
  readonly eventLog: EventLog;
  readonly lockManager: LockManager;
  readonly messageBox: MessageBox;
  readonly workerRegistry: WorkerRegistry;
  readonly subscriptions: SubscriptionStore;
  /**
   * MCP server for worker tool calls. Mounted at `/mcp` on the same Bun.serve
   * instance that hosts the REST API. Workers' MCP clients connect here via
   * the config file written by `WorkerPool.generateMCPConfig()`.
   */
  readonly mcpServer: HubMCPServer;

  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private serverOpenedByStart = false;
  private readonly routes: HubRoute[] = [];
  private dispatchCallback: DispatchCallback | null = null;
  private reportCallback: ReportCallback | null = null;
  private heartbeatCallback: HeartbeatCallback | null = null;
  private schedulerBridge: SchedulerBridge | null = null;
  private askListener: ((request: HelpRequest) => void) | null = null;
  private sseSubscribers = new Set<SSESubscriber>();
  /** Workers blocked in hub_wait, by worker id, with the tasks each one watches. */
  private waiters = new Map<string, { tasks: Set<string>; resolve: (reason: 'task' | 'message' | 'event') => void }>();
  private helpRequests = new Map<string, HelpRequest>();

  /**
   * @param config   Cluster config.
   * @param db       Raw SQLite handle (ContextHub owns its tables).
   * @param ticketsDir Absolute path to the tickets root — same directory
   *   `TicketBackend` and `ClusterTicketWriteback` use. The hub's
   *   `hub_write_plan` / `hub_read_plan` write into `<ticketsDir>/<id>/`.
   */
  constructor(
    private config: ClusterConfig,
    private db: Database,
    private ticketsDir: string,
  ) {
    this.eventLog = new EventLog(db, config.hub.eventLogMaxSize);
    this.lockManager = new LockManager(db, this.eventLog, config.hub.lockTTL, (change) => this.locksChanged(change));
    this.messageBox = new MessageBox(db, (workerId, type) =>
      this.wake(workerId, type === 'event' ? 'event' : 'message'),
    );
    this.workerRegistry = new WorkerRegistry(db);
    this.subscriptions = new SubscriptionStore(db);
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

  /** Told of every question no planner takes first. */
  setAskListener(listener: (request: HelpRequest) => void): void {
    this.askListener = listener;
  }

  /**
   * Mount a route on the hub's server. Routes are matched in registration order by
   * path prefix; a prefix of `/` catches everything left, so it goes last.
   */
  registerRoute(route: HubRoute): void {
    if (this.routes.some((r) => r.prefix === route.prefix)) {
      throw new Error(`[ContextHub] route prefix "${route.prefix}" is already registered`);
    }
    this.routes.push(route);
  }

  /** The URL workers are told to connect to. */
  get url(): string {
    return `http://${this.config.hub.host}:${this.config.hub.port}`;
  }

  /**
   * Bind the HTTP server. Idempotent: a second call while listening is a no-op, which is
   * how `start()` leaves a server that the daemon opened earlier alone.
   */
  listen(): string {
    if (this.httpServer) {
      return this.url;
    }
    const { port, bindHost } = this.config.hub;
    this.httpServer = Bun.serve({
      port,
      hostname: bindHost,
      // MCP clients (claude's streamable HTTP transport in particular) keep
      // HTTP keep-alive connections open across tool calls. The default Bun
      // idleTimeout of 10s prints a "request timed out" warning whenever
      // there's a gap that long between calls, which is false noise — the
      // connection is fine, just idle. Bump to 255s (Bun's max) to silence it
      // without disabling timeouts entirely.
      idleTimeout: 255,
      fetch: (req, server) => this.handleRequest(req, server),
    });
    logger.info(`[ContextHub] Listening on ${bindHost}:${port} (workers connect to ${this.url}/mcp)`);
    return this.url;
  }

  /** Close the HTTP server. Open SSE streams are ended by `stop()`, not here. */
  close(): void {
    if (this.httpServer) {
      this.httpServer.stop();
      this.httpServer = null;
    }
    this.serverOpenedByStart = false;
  }

  /**
   * Start the hub. The MCP server is connected first so the `/mcp` route is ready to
   * accept requests the moment the server is bound.
   */
  async start(): Promise<string> {
    // Start MCP first so /mcp handler is ready before bind.
    await this.mcpServer.start();

    if (!this.httpServer) {
      this.listen();
      this.serverOpenedByStart = true;
    }

    logger.info(`[ContextHub] Started on ${this.url} (REST + /mcp)`);
    return this.url;
  }

  /**
   * Stop the hub. MCP server is closed AFTER the HTTP server so any
   * in-flight tool calls have a chance to drain.
   */
  async stop(): Promise<void> {
    this.lockManager.stop();
    if (this.serverOpenedByStart) {
      this.close();
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
    const taskId = this.workerRegistry.get(workerId)?.lastBoundTaskId;
    if (taskId) {
      this.dropSubscriptions(taskId);
    }
    this.messageBox.discard(workerId);
    this.workerRegistry.markExited(workerId);
    this.eventLog.append('worker_left', workerId, {});
    this.broadcastSSE('worker_status', { workerId, status: 'exited' });
  }

  /** A worker starts on a task: bind them, and hand it what arrived while the task had no worker. */
  bindWorker(workerId: string, taskId: string): void {
    this.workerRegistry.setTask(workerId, taskId);
    this.messageBox.readdress(taskInbox(taskId), workerId);
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
    // The daemon binds a worker to its task when it starts it. A claim naming another task would
    // move the worker's subscriptions, questions and locks onto a task it does not run.
    const bound = this.workerRegistry.get(workerId)?.lastBoundTaskId;
    if (bound && bound !== input.taskId) {
      throw new Error(`hub_claim: task ${input.taskId} is not yours; you run task ${bound}`);
    }
    if (!bound) {
      this.bindWorker(workerId, input.taskId);
    }

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
    if (input.status === 'working' && taskIdSnapshot) {
      this.publishProgress(workerId, taskIdSnapshot, input);
    }

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

    // The owner sees every question through the stream above. A child's planner gets it once as
    // well, because it often knows the answer; an escalation is meant for the owner alone.
    const planner = input.type === 'escalation' ? undefined : this.plannerOf(reg?.currentTaskId);
    if (planner) {
      const relay = renderPrompt(readClusterPrompt('ask-relay.md'), {
        TASK_ID: reg?.currentTaskId,
        ASK_ID: askId,
        TYPE: input.type,
        QUESTION: input.question,
        OPTIONS: input.options?.join(' / ') ?? '',
        CONTEXT: input.context ?? '',
      });
      this.messageBox.send(planner, workerId, relay.trim(), 'message', 'warning');
    } else {
      this.askListener?.(helpRequest);
    }

    return {
      received: true,
      askId,
      expectedResponseTime: planner ? '你的 planner 或 owner 会回答' : '等 owner 回答',
    };
  }

  /** A planner answers its own child; anyone else's question is not its to close. */
  handleAnswer(workerId: string, input: HubAnswerInput): HubAnswerOutput {
    this.workerRegistry.touch(workerId);
    if (this.workerRegistry.get(workerId)?.role !== 'planner') {
      throw new Error('hub_answer is only available to planner-role workers');
    }
    const request = this.helpRequests.get(input.askId);
    if (!request) {
      throw new Error(`hub_answer: no question ${input.askId}`);
    }
    if (this.plannerOf(request.taskId) !== workerId) {
      throw new Error(`hub_answer: question ${input.askId} did not come from one of your children`);
    }
    if (!this.answerHelpRequest(input.askId, input.answer, workerId)) {
      throw new Error(`hub_answer: question ${input.askId} was already answered`);
    }
    return { delivered: true };
  }

  /** The live worker of the planner above this task, if there is one. */
  private plannerOf(taskId: string | undefined): string | undefined {
    const parentId = taskId ? this.schedulerBridge?.findTask(taskId)?.parentTaskId : undefined;
    const parent = parentId ? this.schedulerBridge?.findTask(parentId) : undefined;
    const worker = parent?.workerId ? this.workerRegistry.get(parent.workerId) : undefined;
    return worker && worker.status !== 'exited' ? worker.workerId : undefined;
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
      const sibling = this.schedulerBridge?.findTask(input.to);
      const targetJob = sibling?.jobId ?? this.workerRegistry.getJobId(input.to);
      const ownJob = this.workerRegistry.getJobId(workerId);
      if (targetJob && ownJob && targetJob !== ownJob) {
        throw new Error(`hub_message: ${input.to} is not in your job`);
      }
      const address = sibling ? (sibling.workerId ?? taskInbox(sibling.id)) : input.to;
      this.messageBox.send(address, workerId, input.content, 'message', input.priority);
    }

    this.eventLog.append('message', workerId, {
      to: input.to,
      content: input.content,
      priority: input.priority,
    });

    return { delivered: true };
  }

  /** Hub side of `hub_subscribe`: the interests are added to what the worker's task already has. */
  handleSubscribe(workerId: string, input: HubSubscribeInput): HubSubscribeOutput {
    this.workerRegistry.touch(workerId);
    const task = this.currentTaskOf(workerId, 'hub_subscribe');
    return this.subscribe(task, this.checkInterests('hub_subscribe', task, input), false);
  }

  handleUnsubscribe(workerId: string, input: HubUnsubscribeInput): HubUnsubscribeOutput {
    this.workerRegistry.touch(workerId);
    const task = this.currentTaskOf(workerId, 'hub_unsubscribe');
    this.subscriptions.remove(task.id, {
      ...input,
      files: input.files?.map(normalizeInterestPath),
    });
    return { subscriptions: this.announceSubscriptions(task) };
  }

  /**
   * Subscribe a child `hub_spawn` just created, before the scheduler may start it. The interests
   * were checked by `handleSpawn`. Its `tasks` are its dependencies.
   */
  preSubscribe(child: TaskRecord, interests: HubSubscribeInput): void {
    this.subscribe(child, interests, true);
  }

  /** What must land before this task may start. */
  taskDependencies(taskId: string): string[] {
    return this.subscriptions.dependenciesOf(taskId);
  }

  private currentTaskOf(workerId: string, tool: string): TaskRecord {
    const taskId = this.workerRegistry.get(workerId)?.currentTaskId;
    if (!taskId) {
      throw new Error(`${tool}: worker has no current task`);
    }
    if (!this.schedulerBridge) {
      throw new Error(`${tool}: scheduler bridge not wired (cluster misconfiguration)`);
    }
    const task = this.schedulerBridge.findTask(taskId);
    if (!task) {
      throw new Error(`${tool}: task ${taskId} not found in scheduler`);
    }
    return task;
  }

  /** Answers the interests with their paths normalized, or throws what the caller got wrong. */
  private checkInterests(tool: string, owner: TaskRecord, input: HubSubscribeInput): HubSubscribeInput {
    const tasks = Array.from(new Set(input.tasks ?? []));
    const files = Array.from(new Set((input.files ?? []).map(normalizeInterestPath)));
    if (tasks.length === 0 && files.length === 0 && !input.branch) {
      throw new Error(`${tool}: name at least one of tasks, files or branch`);
    }
    for (const taskId of tasks) {
      if (taskId === owner.id) {
        throw new Error(`${tool}: a task cannot subscribe to itself`);
      }
      // "Not in your job" and "does not exist" look the same, as in hub_query_task.
      if (this.schedulerBridge?.findTask(taskId)?.jobId !== owner.jobId) {
        throw new Error(`${tool}: task ${taskId} is not in your job; subscriptions reach siblings only`);
      }
    }
    return { tasks, files, branch: input.branch === true };
  }

  private subscribe(task: TaskRecord, interests: HubSubscribeInput, dependency: boolean): HubSubscribeOutput {
    const known = new Set(this.subscriptions.of(task.id).tasks);
    this.subscriptions.add(task.id, task.jobId, interests, { dependency });

    // A subscription made after the fact must not wait for an event that already happened.
    const caughtUp = (interests.tasks ?? []).filter((id) => !known.has(id)).flatMap((id) => this.outcomeSoFar(id));
    for (const event of caughtUp) {
      this.deliver(task.id, event);
    }
    return { subscriptions: this.announceSubscriptions(task), caughtUp: caughtUp.length };
  }

  private announceSubscriptions(task: TaskRecord): HubSubscriptions {
    const subscriptions = this.subscriptions.of(task.id);
    this.eventLog.append(
      'task_subscribed',
      task.workerId ?? 'cluster',
      { subscriptions },
      { jobId: task.jobId, taskId: task.id },
    );
    this.broadcastSSE('task_subscribed', { taskId: task.id, jobId: task.jobId, subscriptions });
    return subscriptions;
  }

  private outcomeSoFar(taskId: string): HubSubscriptionEvent[] {
    const task = this.schedulerBridge?.findTask(taskId);
    if (!task) {
      return [];
    }
    const events: HubSubscriptionEvent[] = [];
    const [merged] = task.mergedAt ? this.eventLog.query({ taskId, type: 'task_merged', limit: 1 }) : [];
    if (merged) {
      const { integrationBranch, files, filesTotal } = merged.data as {
        integrationBranch: string;
        files: string[];
        filesTotal: number;
      };
      events.push(this.mergedEvent(task, integrationBranch, files, filesTotal));
    }
    if (this.schedulerBridge?.isTaskSettled(taskId)) {
      events.push(this.outcomeEvent(task));
    }
    return events;
  }

  private mergedEvent(
    task: TaskRecord,
    integrationBranch: string,
    files: string[],
    total: number,
  ): HubSubscriptionEvent {
    return {
      kind: 'task_merged',
      taskId: task.id,
      branch: integrationBranch,
      summary: clip(`Landed on ${integrationBranch}, ${total} file(s) changed. ${task.diffSummary ?? ''}`),
      files: files.slice(0, MAX_EVENT_FILES),
    };
  }

  private outcomeEvent(task: TaskRecord): HubSubscriptionEvent {
    const completed = task.status === 'completed';
    return {
      kind: completed ? 'task_completed' : task.status === 'blocked' ? 'task_blocked' : 'task_failed',
      taskId: task.id,
      branch: task.branch,
      summary: clip((completed ? task.diffSummary : (task.error ?? task.diffSummary)) ?? task.status),
    };
  }

  /** Queued in the MessageBox, whose send hook is what wakes a worker blocked in hub_wait. */
  private deliver(subscriberTaskId: string, event: HubSubscriptionEvent): void {
    const workerId = this.schedulerBridge?.findTask(subscriberTaskId)?.workerId;
    if (!workerId && TRANSIENT_EVENTS.has(event.kind)) {
      return;
    }
    this.messageBox.send(workerId ?? taskInbox(subscriberTaskId), 'hub', JSON.stringify(event), 'event');
  }

  private dropSubscriptions(taskId: string): void {
    this.subscriptions.dropTask(taskId);
    this.messageBox.discard(taskInbox(taskId));
  }

  private publishProgress(workerId: string, taskId: string, input: HubReportInput): void {
    const jobId = this.workerRegistry.getJobId(workerId);
    if (!jobId) {
      return;
    }
    const summary = clip(input.nextSteps ? `${input.summary} Next: ${input.nextSteps}` : input.summary);
    for (const match of this.subscriptions.match(jobId, { taskId })) {
      this.deliver(match.taskId, { kind: 'worker_progress', taskId, summary });
    }
  }

  private locksChanged({ kind, workerId, taskId, files }: LockChange): void {
    const jobId = this.workerRegistry.getJobId(workerId);
    if (!jobId || !taskId) {
      return;
    }
    const verb = kind === 'lock_acquired' ? 'locked' : 'released';
    for (const match of this.subscriptions.match(jobId, { files })) {
      if (match.taskId === taskId) {
        continue;
      }
      this.deliver(match.taskId, {
        kind,
        taskId,
        summary: `${match.files.length} file(s) you follow ${verb} by task ${taskId}`,
        files: match.files.slice(0, MAX_EVENT_FILES),
      });
    }
  }

  /** `hub_say`: the worker speaks to the owner in its task's conversation. */
  handleSay(workerId: string, input: HubSayInput): HubSayOutput {
    this.workerRegistry.touch(workerId);
    const reg = this.workerRegistry.get(workerId);
    const text = input.text?.trim();
    if (!text) {
      throw new Error('hub_say: text is required');
    }
    const taskId = reg?.currentTaskId;
    const jobId = taskId ? this.schedulerBridge?.findTask(taskId)?.jobId : undefined;
    this.eventLog.append('worker_message', workerId, { text }, { taskId, jobId });
    this.broadcastSSE('task_message', { taskId, workerId, from: 'worker', kind: 'say', text });
    return { sent: true };
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
    const subscribe = input.subscribe && this.checkInterests('hub_spawn', parent, input.subscribe);
    for (const dependency of subscribe?.tasks ?? []) {
      const task = this.schedulerBridge.findTask(dependency);
      if (task?.status !== 'completed' && this.schedulerBridge.isTaskSettled(dependency)) {
        throw new Error(`hub_spawn: dependency ${dependency} ended ${task?.status}, so this child could never start`);
      }
    }
    const child = await this.schedulerBridge.submitChildTask({
      parentTaskId,
      parentJobId: parent.jobId,
      project: parent.project,
      description: input.description,
      template: input.template,
      subscribe,
    });
    if (!child) {
      throw new Error(
        `hub_spawn: scheduler refused to create child task — template "${input.template}" is unknown, disabled, or planner-role, ` +
          `or the project is unknown. Pick a template from the available-executor list in your system prompt.`,
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
      status: child.status === 'pending' ? 'queued' : 'running',
    });

    return {
      childTaskId: child.id,
      // tryDispatch leaves status 'pending' when no worker or slot was free; anything else
      // means a worker is on its way, even if its slot is still being prepared.
      status: child.status === 'pending' ? 'queued' : 'running',
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
    const output = target.output;
    const truncated = output !== undefined && output.length > QUERY_OUTPUT_TAIL_CHARS;
    return {
      taskId: target.id,
      status: target.status,
      workerId: target.workerId,
      output: truncated ? output.slice(-QUERY_OUTPUT_TAIL_CHARS) : output,
      outputTruncated: truncated || undefined,
      diffSummary: target.diffSummary,
      error: target.error,
      startedAt: target.startedAt,
      completedAt: target.completedAt,
      branch: target.branch,
      mergedAt: target.mergedAt,
    };
  }

  /**
   * Hub side of `hub_wait`: block until a watched child task settles, a message or a subscribed
   * event arrives for the worker, or the window runs out. Event-driven — nothing polls:
   * `taskSettled` and the MessageBox's send hook wake the waiter. The window stays below the HTTP idle timeout so
   * the blocked MCP request is never cut; a `timeout` answer just means "call again".
   */
  async handleWait(workerId: string, input: HubWaitInput): Promise<HubWaitOutput> {
    const requested = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : WAIT_MAX_MS;
    const timeoutMs = Math.min(requested, WAIT_MAX_MS);
    const tasks = Array.from(new Set((input.tasks ?? []).filter((t) => typeof t === 'string' && t)));
    // A task the hub cannot see (not this worker's child, or gone) is simply not watched.
    const snapshots = (): HubTaskSnapshot[] =>
      tasks.flatMap((taskId) => {
        try {
          const {
            output: _output,
            outputTruncated: _truncated,
            ...snapshot
          } = this.handleQueryTask(workerId, { taskId });
          return [snapshot];
        } catch {
          return [];
        }
      });
    const settled = (snapshot: HubTaskSnapshot) => this.schedulerBridge?.isTaskSettled(snapshot.taskId) === true;

    // Already something to do: answer at once.
    if (snapshots().some(settled)) {
      return { reason: 'task', tasks: snapshots(), updates: this.messageBox.consume(workerId) };
    }
    if (this.messageBox.getUnreadCount(workerId) > 0) {
      const reason = this.messageBox.hasUnreadMessage(workerId) ? 'message' : 'event';
      return { reason, tasks: snapshots(), updates: this.messageBox.consume(workerId) };
    }

    const previous = this.waiters.get(workerId);
    previous?.resolve('message');
    const heartbeat = setInterval(() => {
      try {
        this.heartbeatCallback?.(workerId);
      } catch {
        // A heartbeat failure must not end the wait.
      }
    }, WAIT_HEARTBEAT_MS);
    try {
      const reason = await new Promise<HubWaitOutput['reason']>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        this.waiters.set(workerId, {
          tasks: new Set(tasks),
          resolve: (why) => {
            clearTimeout(timer);
            resolve(why);
          },
        });
      });
      return { reason, tasks: snapshots(), updates: this.messageBox.consume(workerId) };
    } finally {
      clearInterval(heartbeat);
      if (this.waiters.get(workerId)?.tasks) this.waiters.delete(workerId);
    }
  }

  /** `hub_wait_task`: the one-task form of `hub_wait`, answering the task's snapshot as before. */
  async handleWaitTask(workerId: string, input: HubWaitTaskInput): Promise<HubQueryTaskOutput> {
    await this.handleWait(workerId, { tasks: [input.taskId], timeoutMs: input.timeoutMs });
    return this.handleQueryTask(workerId, { taskId: input.taskId });
  }

  /** Something happened to a task outside any worker's report: a merge, a conflict, a publish. */
  recordTaskEvent(type: ClusterEventType, task: TaskRecord, data: Record<string, unknown>): void {
    this.eventLog.append(type, task.workerId ?? 'cluster', data, { jobId: task.jobId, taskId: task.id });
    this.broadcastSSE('task_event', { type, taskId: task.id, jobId: task.jobId, ...data });
  }

  /** The task's branch moved the integration branch; `files` is the whole diff, capped only on the way out. */
  taskMerged(
    task: TaskRecord,
    merge: { branch: string; integrationBranch: string; before: string; head: string; files: string[] },
  ): void {
    const { files, ...refs } = merge;
    this.recordTaskEvent('task_merged', task, {
      ...refs,
      files: files.slice(0, MAX_EVENT_FILES),
      filesTotal: files.length,
    });
    for (const match of this.subscriptions.match(task.jobId, { taskId: task.id, branch: true, files })) {
      if (match.taskId === task.id) {
        continue;
      }
      if (match.viaTask || match.viaBranch) {
        this.deliver(match.taskId, this.mergedEvent(task, merge.integrationBranch, files, files.length));
      } else {
        this.deliver(match.taskId, {
          kind: 'files_changed',
          taskId: task.id,
          branch: merge.integrationBranch,
          summary: `${match.files.length} file(s) you follow changed on ${merge.integrationBranch}`,
          files: match.files.slice(0, MAX_EVENT_FILES),
        });
      }
    }
  }

  /** Tell the task's subscribers how it ended. The scheduler calls this once per task. */
  publishTaskOutcome(task: TaskRecord): void {
    for (const match of this.subscriptions.match(task.jobId, { taskId: task.id })) {
      this.deliver(match.taskId, this.outcomeEvent(task));
    }
  }

  /**
   * A task reached a terminal status (the scheduler says so): wake whoever waits on it. Its own
   * subscriptions end here too, which covers a task that never had a worker to exit.
   */
  taskSettled(taskId: string): void {
    this.dropSubscriptions(taskId);
    for (const [workerId, waiter] of this.waiters) {
      if (waiter.tasks.has(taskId)) {
        this.waiters.delete(workerId);
        waiter.resolve('task');
      }
    }
  }

  private wake(workerId: string, reason: 'message' | 'event'): void {
    const waiter = this.waiters.get(workerId);
    if (!waiter) return;
    this.waiters.delete(workerId);
    waiter.resolve(reason);
  }

  // ── Plan artifact: planner-only persistence of decomposition plans ──

  /**
   * Hub side of `hub_write_plan`. Planner-only. Persists the full plan
   * content as `tickets/<ticketId>/plan.md`. If a plan already exists,
   * archives the old file to `tickets/<ticketId>/plan-v<N>.md` (N =
   * max(existing plan-v*.md suffix) + 1, or 1 if none exist) before writing.
   *
   * The orchestrator does NOT parse or rewrite frontmatter — `plan_version`
   * and other metadata fields are the planner's responsibility. Archive
   * naming is filename-based, not frontmatter-based, so a planner that
   * forgets to bump `plan_version` will still get clean archive numbering.
   *
   * Concurrency: two planners writing the same ticket's plan concurrently
   * could race on the archive step (both compute the same N). Not guarded
   * in Phase 1 because the realistic single-planner-per-ticket case doesn't
   * hit it. See plan artifact §5 Q5 for deferred mutex discussion.
   */
  async handleWritePlan(workerId: string, input: HubWritePlanInput): Promise<HubWritePlanOutput> {
    this.workerRegistry.touch(workerId);
    const reg = this.workerRegistry.get(workerId);
    if (!reg || reg.role !== 'planner') {
      throw new Error('hub_write_plan is only available to planner-role workers');
    }
    const taskId = reg.currentTaskId;
    if (!taskId) {
      throw new Error('hub_write_plan: planner has no current task');
    }
    if (!this.schedulerBridge) {
      throw new Error('hub_write_plan: scheduler bridge not wired (cluster misconfiguration)');
    }
    const task = this.schedulerBridge.findTask(taskId);
    if (!task) {
      throw new Error(`hub_write_plan: task ${taskId} not found in scheduler`);
    }
    const ticketId = this.getTicketIdForJob(task.jobId);
    if (!ticketId) {
      throw new Error(
        `hub_write_plan: job ${task.jobId} has no ticketId — was this ticket dispatched from WebUI? Direct cluster jobs without a ticket cannot use hub_write_plan.`,
      );
    }

    // Locate the ticket dir across project buckets. If the ticket has
    // never been written (planner racing the user's first save), fall
    // back to the bucket implied by the cluster job's project alias —
    // this mirrors how TicketBackend would bucket a freshly created
    // ticket with the same project field.
    let ticketDir = findTicketDir(this.ticketsDir, ticketId);
    if (!ticketDir) {
      ticketDir = ticketDirForCreate(this.ticketsDir, task.project, ticketId);
      await mkdir(ticketDir, { recursive: true });
      logger.warn(
        `[ContextHub] hub_write_plan: ticket dir missing, created safety-net dir ${bucketForProject(task.project)}/${ticketId}`,
      );
    }

    const planPath = join(ticketDir, 'plan.md');
    let archived = false;
    let archivedAs: string | undefined;

    if (existsSync(planPath)) {
      const nextN = await this.computeNextPlanArchiveVersion(ticketDir);
      const archivePath = join(ticketDir, `plan-v${nextN}.md`);
      await rename(planPath, archivePath);
      archived = true;
      archivedAs = relative(getRepoRoot(), archivePath);
    }

    await writeFile(planPath, input.content, 'utf-8');

    const relPath = relative(getRepoRoot(), planPath);
    logger.info(
      `[ContextHub] hub_write_plan: planner=${workerId} ticket=${ticketId} wrote ${relPath}` +
        (archived ? ` (archived old → ${archivedAs})` : ''),
    );
    this.eventLog.append(
      'message',
      workerId,
      {
        kind: 'plan_written',
        ticketId,
        path: relPath,
        archived,
        archivedAs,
      },
      { taskId },
    );

    return {
      written: true,
      path: relPath,
      archived,
      archivedAs,
    };
  }

  /**
   * Hub side of `hub_read_plan`. Planner-only. Returns the current
   * `tickets/<ticketId>/plan.md` content if it exists, or `{ exists: false }`
   * if the planner hasn't written one yet (or the file was manually
   * deleted). Used for resume scenarios: when a planner is respawned
   * after crashing, it should check for an existing plan before redoing
   * the whole decomposition.
   */
  async handleReadPlan(workerId: string): Promise<HubReadPlanOutput> {
    this.workerRegistry.touch(workerId);
    const reg = this.workerRegistry.get(workerId);
    if (!reg || reg.role !== 'planner') {
      throw new Error('hub_read_plan is only available to planner-role workers');
    }
    const taskId = reg.currentTaskId;
    if (!taskId) {
      throw new Error('hub_read_plan: planner has no current task');
    }
    if (!this.schedulerBridge) {
      throw new Error('hub_read_plan: scheduler bridge not wired (cluster misconfiguration)');
    }
    const task = this.schedulerBridge.findTask(taskId);
    if (!task) {
      throw new Error(`hub_read_plan: task ${taskId} not found in scheduler`);
    }
    const ticketId = this.getTicketIdForJob(task.jobId);
    if (!ticketId) {
      throw new Error(
        `hub_read_plan: job ${task.jobId} has no ticketId — this cluster job was not dispatched from a ticket.`,
      );
    }

    const ticketDir = findTicketDir(this.ticketsDir, ticketId);
    if (!ticketDir) return { exists: false };
    const planPath = join(ticketDir, 'plan.md');
    if (!existsSync(planPath)) {
      return { exists: false };
    }
    const content = await readFile(planPath, 'utf-8');
    return {
      exists: true,
      content,
      path: relative(getRepoRoot(), planPath),
    };
  }

  /**
   * Look up `cluster_jobs.ticketId` by job id. Returns null if the job
   * doesn't exist or has no associated ticket (direct cluster jobs without
   * a ticket — legacy path).
   */
  private getTicketIdForJob(jobId: string): string | null {
    const row = this.db.query('SELECT ticketId FROM cluster_jobs WHERE id = ?').get(jobId) as
      | { ticketId: string | null }
      | undefined;
    return row?.ticketId?.trim() || null;
  }

  /**
   * Scan a ticket directory for existing `plan-v<N>.md` files and return
   * the next version number. Returns `max(existing N) + 1`, or `1` if no
   * archive exists. Filename-based to survive manual edits/deletions
   * without ever colliding with an existing archive.
   */
  private async computeNextPlanArchiveVersion(ticketDir: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(ticketDir);
    } catch {
      return 1;
    }
    let maxN = 0;
    for (const entry of entries) {
      const match = entry.match(/^plan-v(\d+)\.md$/);
      if (!match) continue;
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    return maxN + 1;
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
    this.eventLog.append(
      'answer',
      answeredBy,
      { askId, question: request.question, answer },
      { targetWorkerId: request.workerId, taskId: request.taskId },
    );
    this.broadcastSSE('task_message', {
      taskId: request.taskId,
      workerId: request.workerId,
      from: answeredBy,
      kind: 'answer',
      text: answer,
    });

    return true;
  }

  /** A person marked a task as seen; the console's inbox drops it. */
  taskAcknowledged(taskId: string, acknowledgedAt: string): void {
    this.broadcastSSE('task_acknowledged', { taskId, acknowledgedAt });
  }

  /**
   * A person's message to a running worker. It is queued as a directive, which the worker
   * takes on its next hub_sync or hub_report, and recorded on the task's timeline.
   */
  messageWorker(workerId: string, taskId: string | undefined, text: string, from = 'owner'): void {
    this.messageBox.send(workerId, from, text, 'directive', 'warning');
    this.eventLog.append('directive', from, { text }, { targetWorkerId: workerId, taskId });
    this.broadcastSSE('task_message', { taskId, workerId, from, kind: 'directive', text });
  }

  /** Every help request the hub remembers, answered ones included, newest first. */
  getHelpRequests(status: 'pending' | 'all' = 'pending'): HelpRequest[] {
    const all = Array.from(this.helpRequests.values());
    const picked = status === 'all' ? all : all.filter((r) => r.status === 'pending');
    return picked.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
   * The hub's Bun.serve fetch handler: `/mcp` for workers, then the mounted routes.
   *
   * `/mcp` carries no credential (workers identify themselves with `X-Worker-Id`), so it
   * is restricted to loopback peers: the server may be bound to a LAN-visible address for
   * the console, but workers always run on this machine.
   */
  private async handleRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
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
        if (!isLoopbackAddress(server.requestIP(req)?.address)) {
          return Response.json({ error: '/mcp accepts local workers only' }, { status: 403, headers });
        }
        return this.mcpServer.handleRequest(req);
      }

      for (const route of this.routes) {
        if (!routeMatches(route.prefix, path)) {
          continue;
        }
        const response = await route.handle(path, req);
        if (response) {
          return response;
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
      case 'worker_message':
        return String(data.text || '');
      case 'worker_progress':
        return `进展: ${data.summary || ''}${data.nextSteps ? ` → 下一步: ${data.nextSteps}` : ''}`;
      case 'task_completed':
        return `任务完成: ${data.summary || ''}`;
      case 'task_failed':
        return `任务失败: ${data.summary || ''}`;
      case 'task_blocked':
        return `阻塞: ${data.summary || ''}`;
      case 'task_merged':
        return `已合入 ${data.integrationBranch || ''}`;
      case 'job_landed':
        return `已合入 ${data.baseBranch || ''}`;
      case 'task_published':
        return `已发布: ${data.command || ''}`;
      case 'task_publish_failed':
        return `发布失败: ${data.error || ''}`;
      case 'task_subscribed':
        return '更新了事件订阅';
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

function routeMatches(prefix: string, path: string): boolean {
  if (prefix === '/') {
    return true;
  }
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const ip = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return ip === '::1' || ip.startsWith('127.');
}
