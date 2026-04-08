/**
 * ClusterManager — top-level orchestrator for the Agent Cluster.
 *
 * Initializes ContextHub, WorkerPool, ClusterScheduler, registers backends
 * and task sources. Entry point for bootstrap.
 */

import type { Database } from 'bun:sqlite';
import { logger } from '@/utils/logger';
import { ClaudeCliBackend } from './backends/ClaudeCliBackend';
import type { ClusterConfig } from './config';
import { ClusterScheduler } from './ClusterScheduler';
import { ContextHub } from './ContextHub';
import { QueueSource } from './sources/QueueSource';
import { TodoFileSource } from './sources/TodoFileSource';
import type { ClusterStatus, TaskRecord } from './types';
import { WorkerPool } from './WorkerPool';

export class ClusterManager {
  private hub: ContextHub;
  private workerPool: WorkerPool;
  private scheduler: ClusterScheduler;
  private queueSources = new Map<string, QueueSource>();
  private started = false;

  constructor(
    private config: ClusterConfig,
    private db: Database,
    private projectResolver: (alias: string) => { alias: string; path: string; type: string } | undefined,
  ) {
    this.hub = new ContextHub(config, db);
    this.workerPool = new WorkerPool(config, this.hub);
    this.scheduler = new ClusterScheduler(config, this.hub, this.workerPool, db, projectResolver);

    // Wire dispatch callback
    this.hub.setDispatchCallback(async (candidate) => {
      const queueSource = this.queueSources.get(candidate.project);
      if (queueSource) {
        queueSource.enqueue(candidate);
      }
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

    this.started = true;
    logger.info('[ClusterManager] Agent Cluster started');
  }

  /**
   * Stop the cluster.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    logger.info('[ClusterManager] Stopping Agent Cluster...');

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
   * Submit a manual task.
   */
  async submitTask(project: string, description: string): Promise<TaskRecord | null> {
    return this.scheduler.submitTask(project, description);
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
   * Access the scheduler for task/job queries.
   */
  getScheduler(): ClusterScheduler {
    return this.scheduler;
  }

  /**
   * Check if started.
   */
  isStarted(): boolean {
    return this.started;
  }

  // ── Private ──

  private registerBackends(): void {
    for (const [name, template] of Object.entries(this.config.workerTemplates)) {
      if (template.type === 'claude-cli') {
        this.workerPool.registerBackend(
          new ClaudeCliBackend(template.command, template.args),
        );
        break; // Only need one backend instance per type
      }
    }
    // Fallback: always register a default claude-cli backend
    if (!this.workerPool.getWorkers().length) {
      this.workerPool.registerBackend(new ClaudeCliBackend());
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
        metadata TEXT
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
        metadata TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS cluster_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
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

    logger.info('[ClusterManager] Database tables initialized');
  }
}
