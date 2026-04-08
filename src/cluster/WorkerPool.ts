/**
 * WorkerPool — manages worker instance lifecycles.
 *
 * Spawns, tracks, and terminates worker processes.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';
import type { ClusterConfig, WorkerTemplateConfig } from './config';
import type { ContextHub } from './ContextHub';
import type { ClusterStatus, TaskRecord, WorkerBackend, WorkerInstance } from './types';

export class WorkerPool {
  private workers = new Map<string, WorkerInstance>();
  private backends = new Map<string, WorkerBackend>();
  private paused = false;
  private running = false;

  constructor(
    private config: ClusterConfig,
    private hub: ContextHub,
  ) {}

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
   * Stop all workers and clean up.
   */
  async stop(): Promise<void> {
    this.running = false;
    const promises: Promise<void>[] = [];
    for (const worker of this.workers.values()) {
      promises.push(this.killWorkerInstance(worker));
    }
    await Promise.allSettled(promises);
    this.workers.clear();
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
   */
  async spawnWorker(
    templateName: string,
    project: string,
    projectPath: string,
    task: TaskRecord,
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
      logger.error(`[WorkerPool] No backend registered for type: ${backendType}`);
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
      role: 'coder',
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
        env: {
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
      this.workers.delete(workerId);
      this.hub.workerExited(workerId);
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
   * Get all worker instances.
   */
  getWorkers(): WorkerInstance[] {
    return Array.from(this.workers.values());
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
        logger.warn(`[WorkerPool] Worker ${worker.id} appears stuck (no report for ${Math.round((now - worker.lastReport) / 1000)}s)`);
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

  private async killWorkerInstance(worker: WorkerInstance): Promise<void> {
    worker.status = 'stopping';
    if (worker.process) {
      try {
        worker.process.kill();
      } catch {
        // Process may have already exited
      }
    }
    worker.status = 'exited';
    worker.process = null;
    this.hub.workerExited(worker.id);
  }

  private async monitorProcess(worker: WorkerInstance, proc: import('bun').Subprocess): Promise<void> {
    // Collect stdout
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

    // Wait for exit
    const exitCode = await proc.exited;
    const output = stdoutChunks.join('');

    logger.info(`[WorkerPool] Worker ${worker.id} exited with code ${exitCode}`);

    // Update worker state
    worker.status = 'exited';
    worker.process = null;

    // Notify hub
    this.hub.workerExited(worker.id);

    // Store output on the task (if still exists)
    if (worker.currentTask) {
      worker.currentTask.output = output;
      worker.currentTask.status = exitCode === 0 ? 'completed' : 'failed';
      if (exitCode !== 0) {
        worker.currentTask.error = `Process exited with code ${exitCode}`;
      }
    }
  }

  private async generateMCPConfig(workerId: string, hubUrl: string): Promise<string> {
    // Generate a temporary MCP config file that points to our ContextHub
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

  private getTemplateConfig(templateName: string): WorkerTemplateConfig | undefined {
    return this.config.workerTemplates[templateName];
  }
}
