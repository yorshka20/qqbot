/**
 * WorkerPool — manages worker instance lifecycles.
 *
 * Spawns, tracks, and terminates worker processes.
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/utils/logger';
import type { ContextHub } from './ContextHub';
import type { ClusterConfig } from './config';
import type { ClusterStatus, TaskRecord, WorkerBackend, WorkerInstance } from './types';

/**
 * Callback invoked when a worker process exits and its task transitions to
 * a terminal state (`completed` / `failed`). Receives the populated
 * `TaskRecord` with `output` / `error` / `completedAt` filled in.
 *
 * Wired by ClusterManager to `ClusterScheduler.markTaskCompleted` so the
 * scheduler can persist final state, update parent job counts, and remove
 * the task from `activeTasks`. See docs/local/agent-cluster.md Issue D.
 */
export type TaskCompletedCallback = (task: TaskRecord) => void | Promise<void>;

/**
 * Maximum number of recently-exited workers retained in memory for
 * status / history queries before they fall off the FIFO buffer.
 */
const RECENTLY_EXITED_MAX = 50;

export class WorkerPool {
  private workers = new Map<string, WorkerInstance>();
  /** FIFO history of exited worker instances; capped at RECENTLY_EXITED_MAX. */
  private recentlyExited: WorkerInstance[] = [];
  private backends = new Map<string, WorkerBackend>();
  private paused = false;
  private running = false;
  private taskCompletedCallback: TaskCompletedCallback | null = null;

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
  ) {}

  /**
   * Register a callback that fires when a worker exits and its task
   * reaches a terminal state. Idempotent — last setter wins.
   */
  setTaskCompletedCallback(cb: TaskCompletedCallback): void {
    this.taskCompletedCallback = cb;
  }

  /**
   * Register a backend implementation.
   */
  registerBackend(backend: WorkerBackend): void {
    this.backends.set(backend.name, backend);
    logger.info(`[WorkerPool] Backend registered: ${backend.name}`);
  }

  /**
   * Start the pool.
   */
  async start(): Promise<void> {
    this.running = true;
    logger.info('[WorkerPool] Started');
  }

  /**
   * Stop all workers and clean up. Sends kill signals to every live
   * worker, then waits for each subprocess to exit so the in-flight
   * `monitorProcess` loops can run their normal teardown path
   * (recordExited + taskCompletedCallback). Falls back to a hard clear
   * if anything is still around after the drain.
   */
  async stop(): Promise<void> {
    this.running = false;

    const exitPromises: Promise<unknown>[] = [];
    for (const worker of this.workers.values()) {
      if (worker.process) {
        exitPromises.push((worker.process.exited as unknown as Promise<unknown>).catch(() => undefined));
      }
      void this.killWorkerInstance(worker);
    }

    await Promise.allSettled(exitPromises);
    // Yield once more so any pending monitorProcess microtasks (recordExited /
    // taskCompletedCallback) get a chance to run before we hard-clear.
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (this.workers.size > 0) {
      logger.warn(`[WorkerPool] ${this.workers.size} worker(s) did not drain cleanly; force-clearing`);
      this.workers.clear();
    }
    this.recentlyExited = [];
    logger.info('[WorkerPool] Stopped, all workers terminated');
  }

  /**
   * Pause — stop accepting new tasks.
   */
  pause(): void {
    this.paused = true;
    logger.info('[WorkerPool] Paused');
  }

  /**
   * Resume accepting new tasks.
   */
  resume(): void {
    this.paused = false;
    logger.info('[WorkerPool] Resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Spawn a new worker for a task.
   * @param role Worker role: 'coder' (default) or 'planner'
   */
  async spawnWorker(
    templateName: string,
    project: string,
    projectPath: string,
    task: TaskRecord,
    role: 'coder' | 'planner' = 'coder',
  ): Promise<WorkerInstance | null> {
    if (this.paused) {
      logger.warn('[WorkerPool] Pool is paused, not spawning');
      return null;
    }

    const template = this.config.workerTemplates[templateName];
    if (!template) {
      logger.error(`[WorkerPool] Unknown worker template: ${templateName}`);
      return null;
    }

    // Check concurrent limits
    if (!this.canSpawnMore(templateName)) {
      logger.warn(`[WorkerPool] Cannot spawn more workers (limit reached)`);
      return null;
    }

    const backendType = template.type || 'claude-cli';
    const backend = this.backends.get(backendType);
    if (!backend) {
      logger.error(`[WorkerPool] No backend registered for type: ${backendType} (template "${templateName}")`);
      return null;
    }

    const workerId = `worker-${randomUUID().slice(0, 8)}`;
    const hubUrl = `http://${this.config.hub.host}:${this.config.hub.port}`;

    // Generate MCP config for worker
    const mcpConfigPath = await this.generateMCPConfig(workerId, hubUrl);

    const workerInstance: WorkerInstance = {
      id: workerId,
      templateName,
      project,
      process: null,
      status: 'starting',
      currentTask: task,
      startedAt: Date.now(),
      lastReport: Date.now(),
    };

    this.workers.set(workerId, workerInstance);

    // Register in hub
    this.hub.workerRegistry.register(workerId, {
      role,
      project,
      templateName,
    });
    this.hub.eventLog.append('worker_joined', workerId, {
      template: templateName,
      project,
      taskId: task.id,
    });

    try {
      const proc = await backend.spawn({
        workerId,
        taskPrompt: task.description,
        projectPath,
        mcpConfigPath,
        hubUrl,
        command: template.command,
        args: template.args,
        env: {
          ...(template.env || {}),
          CLUSTER_WORKER_ID: workerId,
          CLUSTER_HUB_URL: hubUrl,
          CLUSTER_TASK_ID: task.id,
        },
        timeout: template.timeout,
      });

      workerInstance.process = proc;
      workerInstance.status = 'running';

      // Collect output and handle exit
      this.monitorProcess(workerInstance, proc);

      logger.info(`[WorkerPool] Worker ${workerId} spawned for task ${task.id}`);
      return workerInstance;
    } catch (err) {
      logger.error(`[WorkerPool] Failed to spawn worker ${workerId}:`, err);
      // Spawn failed before monitorProcess attached — clean up directly here
      // since the normal monitor path will never run for this worker.
      this.workers.delete(workerId);
      this.hub.workerExited(workerId);
      // Surface the failure to the scheduler so the task transitions to
      // 'failed' instead of being stuck in 'pending' forever.
      if (this.taskCompletedCallback) {
        try {
          task.status = 'failed';
          task.error = err instanceof Error ? err.message : String(err);
          task.completedAt = new Date().toISOString();
          await this.taskCompletedCallback(task);
        } catch (cbErr) {
          logger.error(`[WorkerPool] taskCompletedCallback threw on spawn-failure path:`, cbErr);
        }
      }
      return null;
    }
  }

  /**
   * Kill a specific worker.
   */
  async killWorker(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    await this.killWorkerInstance(worker);
    return true;
  }

  /**
   * Check if we can spawn more workers (global + per-template limits).
   */
  canSpawnMore(templateName?: string): boolean {
    const activeCount = this.getActiveCount();
    if (activeCount >= this.config.maxConcurrentWorkers) return false;

    if (templateName) {
      const template = this.config.workerTemplates[templateName];
      if (template) {
        const templateCount = Array.from(this.workers.values()).filter(
          (w) => w.templateName === templateName && w.status !== 'exited',
        ).length;
        if (templateCount >= template.maxConcurrent) return false;
      }
    }

    return true;
  }

  /**
   * Get cluster status.
   */
  getStatus(): ClusterStatus {
    const workers = Array.from(this.workers.values());
    const now = Date.now();

    return {
      running: this.running,
      paused: this.paused,
      activeWorkers: workers.filter((w) => w.status === 'running').length,
      idleWorkers: workers.filter((w) => w.status === 'idle').length,
      pendingTasks: 0, // filled by scheduler
      runningTasks: workers.filter((w) => w.status === 'running' && w.currentTask).length,
      completedTasks: 0, // filled by scheduler
      failedTasks: 0, // filled by scheduler
      workers: workers
        .filter((w) => w.status !== 'exited')
        .map((w) => ({
          id: w.id,
          template: w.templateName,
          project: w.project,
          status: w.status,
          currentTaskDescription: w.currentTask?.description,
          uptime: now - w.startedAt,
        })),
    };
  }

  /**
   * Get all live worker instances (excludes recently-exited history).
   */
  getWorkers(): WorkerInstance[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get the FIFO history of recently-exited workers (most recent last).
   * Capped at RECENTLY_EXITED_MAX entries.
   */
  getHistory(): readonly WorkerInstance[] {
    return this.recentlyExited;
  }

  /**
   * Get active worker count.
   */
  getActiveCount(): number {
    return Array.from(this.workers.values()).filter((w) => w.status !== 'exited').length;
  }

  /**
   * Health check — detect stuck or exited workers.
   */
  healthCheck(timeoutMs: number = 600_000): string[] {
    const now = Date.now();
    const stuckWorkers: string[] = [];

    for (const worker of this.workers.values()) {
      if (worker.status === 'running' && now - worker.lastReport > timeoutMs) {
        logger.warn(
          `[WorkerPool] Worker ${worker.id} appears stuck (no report for ${Math.round((now - worker.lastReport) / 1000)}s)`,
        );
        stuckWorkers.push(worker.id);
      }
    }

    return stuckWorkers;
  }

  /**
   * Update lastReport timestamp for a worker (called when hub receives a report).
   */
  updateLastReport(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastReport = Date.now();
    }
  }

  // ── Private ──

  /**
   * Send a kill signal to a worker subprocess. The actual cleanup
   * (status update, hub notification, recordExited, callback) is handled
   * by `monitorProcess` once `proc.exited` resolves — this method only
   * triggers the exit, it does NOT clean up state itself, to avoid
   * doubled-up `hub.workerExited` calls and race conditions with the
   * monitor loop.
   */
  private async killWorkerInstance(worker: WorkerInstance): Promise<void> {
    worker.status = 'stopping';
    if (worker.process) {
      try {
        worker.process.kill();
      } catch {
        // Process may have already exited.
      }
    }
  }

  private async monitorProcess(worker: WorkerInstance, proc: import('bun').Subprocess): Promise<void> {
    // Collect stdout (best-effort; stream may close mid-read on kill).
    const stdoutChunks: string[] = [];
    if (proc.stdout) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutChunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Stream closed
      }
    }

    // Wait for exit.
    const exitCode = await proc.exited;
    const rawOutput = stdoutChunks.join('');

    logger.info(`[WorkerPool] Worker ${worker.id} exited with code ${exitCode}`);

    // Update worker state.
    worker.status = 'exited';
    worker.process = null;

    // Notify hub (event log + worker registry).
    this.hub.workerExited(worker.id);

    // Populate the task with final output / status. Use the backend's
    // `parseOutput` (Issue C — stream-json parser) when available so the
    // user-facing `task.output` is the clean final message instead of a
    // wall of JSONL events. Raw events go on `task.metadata` for replay.
    if (worker.currentTask) {
      const backend = this.backends.get(this.config.workerTemplates[worker.templateName]?.type || 'claude-cli');
      let finalMessage = rawOutput;
      let rawEvents: unknown;
      if (backend?.parseOutput) {
        try {
          const parsed = backend.parseOutput(rawOutput);
          finalMessage = parsed.finalMessage;
          rawEvents = parsed.rawEvents;
        } catch (err) {
          logger.warn(
            `[WorkerPool] parseOutput threw for worker ${worker.id} (backend=${backend.name}); falling back to raw stdout:`,
            err,
          );
        }
      }

      worker.currentTask.output = finalMessage;
      worker.currentTask.status = exitCode === 0 ? 'completed' : 'failed';
      worker.currentTask.completedAt = new Date().toISOString();
      if (exitCode !== 0) {
        worker.currentTask.error = `Process exited with code ${exitCode}`;
      }
      if (rawEvents !== undefined) {
        try {
          worker.currentTask.metadata = JSON.stringify({ rawEvents });
        } catch {
          // Non-serializable events — drop silently, finalMessage is what matters.
        }
      }
    }

    // Move into recently-exited history before deleting from the live map.
    // This bounds memory growth (Issue G) while still letting status APIs
    // and the e2e script see the final state of just-finished workers.
    this.recordExited(worker);

    // Fire the completion callback so the scheduler can persist final state,
    // update job counts, and remove the task from `activeTasks`. Failures in
    // the callback should NOT crash the monitor — log and continue.
    if (worker.currentTask && this.taskCompletedCallback) {
      try {
        await this.taskCompletedCallback(worker.currentTask);
      } catch (err) {
        logger.error(`[WorkerPool] taskCompletedCallback threw for worker ${worker.id}:`, err);
      }
    }
  }

  /**
   * Move a worker from the live `workers` map into the bounded
   * `recentlyExited` FIFO. Idempotent — calling twice for the same worker
   * is safe (second call is a no-op).
   */
  private recordExited(worker: WorkerInstance): void {
    if (!this.workers.has(worker.id)) return;
    this.workers.delete(worker.id);
    this.recentlyExited.push(worker);
    while (this.recentlyExited.length > RECENTLY_EXITED_MAX) {
      this.recentlyExited.shift();
    }
  }

  private async generateMCPConfig(workerId: string, hubUrl: string): Promise<string> {
    // Generate a temporary MCP config file that points to our ContextHub.
    // Format is Claude CLI's `--mcp-config` shape (mcpServers object).
    const mcpConfig = {
      mcpServers: {
        'context-hub': {
          url: hubUrl,
          headers: {
            'X-Worker-Id': workerId,
          },
        },
      },
    };

    const configPath = join(tmpdir(), `cluster-mcp-${workerId}.json`);
    await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));
    return configPath;
  }
}
