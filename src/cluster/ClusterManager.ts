/**
 * ClusterManager — top-level orchestrator for the Agent Cluster.
 *
 * Initializes ContextHub, WorkerPool, ClusterScheduler, registers backends
 * and task sources. Entry point for bootstrap.
 */

import type { Database } from 'bun:sqlite';
import type { ProjectRegistry } from '@/services/claudeCode/ProjectRegistry';
import { logger } from '@/utils/logger';
import { ClaudeCliBackend } from './backends/ClaudeCliBackend';
import { CodexCliBackend } from './backends/CodexCliBackend';
import { GeminiCliBackend } from './backends/GeminiCliBackend';
import { MinimaxBackend } from './backends/MinimaxBackend';
import { ClusterScheduler } from './ClusterScheduler';
import type { ClusterConfig } from './config';
import { ContextHub } from './hub/ContextHub';
import { PlannerService } from './PlannerService';
import { QueueSource } from './sources/QueueSource';
import { TodoFileSource } from './sources/TodoFileSource';
import type { ClusterStatus, HelpRequest, JobRecord, TaskRecord } from './types';
import { WorkerPool } from './WorkerPool';

export class ClusterManager {
  private hub: ContextHub;
  private workerPool: WorkerPool;
  private scheduler: ClusterScheduler;
  private plannerService: PlannerService;
  private queueSources = new Map<string, QueueSource>();
  private started = false;

  constructor(
    private config: ClusterConfig,
    private db: Database,
    projectRegistry: ProjectRegistry,
  ) {
    this.hub = new ContextHub(config, db);
    this.workerPool = new WorkerPool(config, this.hub);
    this.scheduler = new ClusterScheduler(config, this.hub, this.workerPool, db, projectRegistry);
    this.plannerService = new PlannerService(config, this.hub, this.workerPool);

    // Wire dispatch callback
    this.hub.setDispatchCallback(async (candidate) => {
      const queueSource = this.queueSources.get(candidate.project);
      if (queueSource) {
        queueSource.enqueue(candidate);
      }
    });

    // Wire task-completion callback: when a worker exits, the scheduler
    // persists the task's terminal state, updates job counters, and removes
    // it from the active map. See docs/local/agent-cluster.md Issue D.
    this.workerPool.setTaskCompletedCallback((task) => {
      this.scheduler.markTaskCompleted(task);
    });

    this.workerPool.setTaskProgressCallback((task) => {
      this.scheduler.flushRunningTaskOutput(task);
      // Broadcast intermediate output so WebUI can show live worker progress
      this.hub.broadcastTaskOutput(task.id, task.workerId, task.output);
    });

    // Wire hub_report callback (Phase 2 round 2, agent-cluster.md §2.3):
    // when a worker voluntarily declares done via hub_report, update the
    // live TaskRecord in-place and flush it through markTaskCompleted so
    // scheduler state (DB + job counters + activeTasks) advances without
    // waiting for the kernel exit code. The later taskCompletedCallback
    // on process exit will re-run markTaskCompleted, but that path is
    // idempotent now — persistTask will overwrite the DB row with any
    // richer stdout captured post-report, and job counters only update
    // on the first call.
    // Wire scheduler bridge for Phase 3 planner-only MCP tools (hub_spawn /
    // hub_query_task / hub_wait_task). The bridge gives ContextHub minimal
    // access to the scheduler (submitChildTask + findTask) without
    // collapsing the layering — see SchedulerBridge in ContextHub.ts for
    // the full rationale.
    this.hub.setSchedulerBridge({
      submitChildTask: (opts) => this.scheduler.submitChildTask(opts),
      findTask: (taskId) => this.scheduler.findTask(taskId),
    });

    this.hub.setReportCallback((workerId, taskId, input) => {
      if (!taskId) {
        logger.warn(
          `[ClusterManager] reportCallback: worker ${workerId} reported ${input.status} without a taskId; cannot advance scheduler state`,
        );
        return;
      }
      const task = this.scheduler.getActiveTask(taskId);
      if (!task) {
        // Already removed from activeTasks — either the exit-code path
        // beat us to it, or the worker reported after a prior fatal error.
        // Nothing to do.
        return;
      }
      task.status = input.status === 'completed' ? 'completed' : 'failed';
      task.completedAt = new Date().toISOString();
      // **Do NOT overwrite `task.output` here.** parseOutput on process
      // exit is the sole authoritative source for `output`. report.summary
      // is a short LLM-authored one-liner ("completed unit tests, 12
      // passed") that often arrives BEFORE the agent finishes printing the
      // actual answer to stdout — clobbering output now would lose that.
      // The summary is already preserved on the corresponding
      // task_completed event in EventLog if anything needs to surface it.
      if (input.status === 'failed' && input.detail?.error) {
        task.error = input.detail.error;
      }
      this.scheduler.markTaskCompleted(task);
    });

    // Register backends
    this.registerBackends();

    // Register task sources per project
    this.registerTaskSources();
  }

  /**
   * Start the cluster (ContextHub server + WorkerPool + Scheduler).
   */
  async start(): Promise<void> {
    if (this.started) return;

    logger.info('[ClusterManager] Starting Agent Cluster...');

    // Initialize DB tables
    this.initDatabase();

    // Start hub
    await this.hub.start();

    // Start pool
    await this.workerPool.start();

    // Start scheduler
    await this.scheduler.start();

    // Up-front project alias validation. Done after scheduler.start() so
    // we have a single error log surfacing misconfigured aliases instead
    // of silent skips on every scheduling tick. Non-fatal — cluster keeps
    // running with whatever projects DO resolve.
    const missingProjects = this.scheduler.validateProjects();
    if (missingProjects.length > 0) {
      logger.warn(
        `[ClusterManager] Cluster started with ${missingProjects.length} unresolved project alias(es): ${missingProjects.join(', ')}`,
      );
    }

    // Start planner service
    this.plannerService.start();

    this.started = true;
    logger.info('[ClusterManager] Agent Cluster started');
  }

  /**
   * Stop the cluster.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    logger.info('[ClusterManager] Stopping Agent Cluster...');

    this.plannerService.stop();
    await this.scheduler.stop();
    await this.workerPool.stop();
    await this.hub.stop();

    this.started = false;
    logger.info('[ClusterManager] Agent Cluster stopped');
  }

  /**
   * Pause scheduling (current workers continue).
   */
  pause(): void {
    this.workerPool.pause();
  }

  /**
   * Resume scheduling.
   */
  resume(): void {
    this.workerPool.resume();
  }

  /**
   * Submit a manual task. `options.workerTemplate` overrides the project's
   * default `workerPreference` for this run only — used by the WebUI submit
   * form's template picker. `options.requirePlannerRole` enforces that the
   * resolved template has `role: 'planner'` (set by ticket dispatch when
   * the ticket frontmatter has `usePlanner: true`).
   */
  async submitTask(
    project: string,
    description: string,
    options?: { workerTemplate?: string; requirePlannerRole?: boolean; ticketId?: string },
  ): Promise<TaskRecord | null> {
    return this.scheduler.submitTask(project, description, options);
  }

  /**
   * Kill a specific worker.
   */
  async killWorker(workerId: string): Promise<boolean> {
    return this.workerPool.killWorker(workerId);
  }

  /**
   * Get cluster status.
   */
  getStatus(): ClusterStatus {
    return this.workerPool.getStatus();
  }

  /**
   * Access the hub for API endpoints.
   */
  getHub(): ContextHub {
    return this.hub;
  }

  /**
   * Access the parsed cluster config (for read-only WebUI views like
   * /api/cluster/templates, which need to expose workerTemplates +
   * per-project workerPreference even before the cluster is started).
   */
  getConfig(): ClusterConfig {
    return this.config;
  }

  /**
   * Access the scheduler for task/job queries.
   */
  getScheduler(): ClusterScheduler {
    return this.scheduler;
  }

  /**
   * Access the planner service (for wiring escalation callbacks from
   * outside the cluster module).
   */
  getPlannerService(): PlannerService {
    return this.plannerService;
  }

  /**
   * Wire human-escalation notification for hub_ask requests. Called from
   * bootstrap once MessageAPI is constructed. The cluster module
   * intentionally doesn't import MessageAPI / ProtocolName directly —
   * keeping it self-contained means a future deployment without QQ
   * (e.g. WebUI-only) can skip this wiring. Without it, escalation
   * requests still get persisted and surfaced via the WebUI / `/cluster
   * ask list` command, just no QQ push notification.
   *
   * `notify` receives the same `HelpRequest` shape as the underlying
   * `EscalationCallback` and is expected to handle delivery + error
   * recovery internally.
   */
  attachEscalationNotifier(notify: (request: HelpRequest) => Promise<void> | void): void {
    this.plannerService.setEscalationCallback(notify);
    logger.info('[ClusterManager] Escalation notifier attached');
  }

  /**
   * Wire a callback that fires when a job reaches terminal status.
   * Used by bootstrap to connect ticket result writeback.
   */
  setJobCompletedCallback(cb: (job: JobRecord, tasks: TaskRecord[]) => void): void {
    this.scheduler.setJobCompletedCallback(cb);
  }

  /**
   * Answer a pending hub_ask help request from outside the cluster
   * module (typically a `/cluster ask answer` QQ command). Returns
   * `false` if the askId is unknown or already answered.
   */
  answerHelpRequest(askId: string, answer: string, answeredBy: string): boolean {
    return this.hub.answerHelpRequest(askId, answer, answeredBy);
  }

  /**
   * List currently-pending help requests. Used by `/cluster ask list`
   * and the WebUI's pending-help panel.
   */
  getPendingHelpRequests(): HelpRequest[] {
    return this.hub.getPendingHelpRequests();
  }

  /**
   * Check if started.
   */
  isStarted(): boolean {
    return this.started;
  }

  // ── Private ──

  private registerBackends(): void {
    // Backends are now stateless: per-template command/args/env flow through
    // WorkerSpawnConfig at spawn time. We register one instance per type that
    // appears in the workerTemplates config. claude-cli is always registered
    // as a safe default (also used by anthropic-compat templates like MiniMax
    // via ANTHROPIC_BASE_URL env override).
    const types = new Set<string>();
    for (const tpl of Object.values(this.config.workerTemplates)) {
      types.add(tpl.type || 'claude-cli');
    }
    types.add('claude-cli'); // always available as fallback

    if (types.has('claude-cli')) {
      this.workerPool.registerBackend(new ClaudeCliBackend());
    }
    if (types.has('codex-cli')) {
      this.workerPool.registerBackend(new CodexCliBackend());
    }
    if (types.has('gemini-cli')) {
      this.workerPool.registerBackend(new GeminiCliBackend());
    }
    if (types.has('minimax-cli')) {
      this.workerPool.registerBackend(new MinimaxBackend());
    }
  }

  private registerTaskSources(): void {
    for (const [projectAlias, projectConfig] of Object.entries(this.config.projects)) {
      const sources = [];
      for (const sourceConfig of projectConfig.taskSources) {
        switch (sourceConfig.type) {
          case 'todo-file': {
            sources.push(new TodoFileSource(sourceConfig.path || 'todo.md'));
            break;
          }
          case 'queue': {
            const queueSource = new QueueSource();
            this.queueSources.set(projectAlias, queueSource);
            sources.push(queueSource);
            break;
          }
        }
      }
      this.scheduler.registerSources(projectAlias, sources);
    }
  }

  private initDatabase(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS cluster_jobs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        taskCount INTEGER DEFAULT 0,
        tasksCompleted INTEGER DEFAULT 0,
        tasksFailed INTEGER DEFAULT 0,
        metadata TEXT,
        ticketId TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS cluster_tasks (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL,
        project TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        workerId TEXT,
        workerTemplate TEXT,
        source TEXT,
        createdAt TEXT NOT NULL,
        claimedAt TEXT,
        startedAt TEXT,
        completedAt TEXT,
        output TEXT,
        error TEXT,
        filesModified TEXT,
        diffSummary TEXT,
        metadata TEXT,
        parentTaskId TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cluster_tasks_parent ON cluster_tasks(parentTaskId)`,
      `CREATE TABLE IF NOT EXISTS cluster_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        type TEXT NOT NULL,
        sourceWorkerId TEXT,
        targetWorkerId TEXT,
        data TEXT NOT NULL,
        jobId TEXT,
        taskId TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cluster_events_worker ON cluster_events(sourceWorkerId, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_cluster_events_type ON cluster_events(type, seq)`,
      `CREATE TABLE IF NOT EXISTS cluster_locks (
        filePath TEXT PRIMARY KEY,
        workerId TEXT NOT NULL,
        taskId TEXT,
        claimedAt INTEGER NOT NULL,
        lastRenewed INTEGER NOT NULL,
        ttl INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS cluster_help_requests (
        id TEXT PRIMARY KEY,
        workerId TEXT NOT NULL,
        taskId TEXT,
        type TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        options TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        answer TEXT,
        answeredBy TEXT,
        createdAt TEXT NOT NULL,
        answeredAt TEXT
      )`,
    ];

    for (const stmt of statements) {
      try {
        this.db.query(stmt).run();
      } catch (err) {
        logger.error('[ClusterManager] Migration error:', err);
      }
    }

    this.migrateClusterEventsCreatedAtColumn();
    this.migrateClusterJobsTicketIdColumn();

    logger.info('[ClusterManager] Database tables initialized');
  }

  /**
   * Older deployments created `cluster_events` before `createdAt` existed.
   * `CREATE TABLE IF NOT EXISTS` does not add new columns — ALTER + backfill.
   */
  private migrateClusterEventsCreatedAtColumn(): void {
    try {
      const cols = this.db.query('PRAGMA table_info(cluster_events)').all() as Array<{ name: string }>;
      if (cols.length === 0) {
        return;
      }
      if (cols.some((c) => c.name === 'createdAt')) {
        return;
      }
      this.db.run('ALTER TABLE cluster_events ADD COLUMN createdAt TEXT');
      this.db.run(
        `UPDATE cluster_events SET createdAt = datetime(timestamp / 1000, 'unixepoch') || 'Z' WHERE createdAt IS NULL`,
      );
      logger.info('[ClusterManager] Migrated cluster_events: added createdAt column (backfilled from timestamp)');
    } catch (err) {
      logger.error('[ClusterManager] cluster_events createdAt migration failed:', err);
    }
  }

  private migrateClusterJobsTicketIdColumn(): void {
    try {
      const cols = this.db.query('PRAGMA table_info(cluster_jobs)').all() as Array<{ name: string }>;
      if (cols.length === 0) return;
      if (cols.some((c) => c.name === 'ticketId')) return;
      this.db.run('ALTER TABLE cluster_jobs ADD COLUMN ticketId TEXT');
      logger.info('[ClusterManager] Migrated cluster_jobs: added ticketId column');
    } catch (err) {
      logger.error('[ClusterManager] cluster_jobs ticketId migration failed:', err);
    }
  }
}
