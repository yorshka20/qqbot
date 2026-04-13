/**
 * WorkerPool — manages worker instance lifecycles.
 *
 * Spawns, tracks, and terminates worker processes.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { logger } from '@/utils/logger';
import type { ClusterConfig } from './config';
import type { ContextHub } from './hub/ContextHub';
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

/** Throttled flush of partial stdout to the scheduler DB while a worker runs. */
export type TaskProgressCallback = (task: TaskRecord) => void | Promise<void>;

/**
 * Maximum number of recently-exited workers retained in memory for
 * status / history queries before they fall off the FIFO buffer.
 */
const RECENTLY_EXITED_MAX = 50;

/**
 * Phase 3: relative paths (from project cwd) to the role-specific system
 * prompt files. Loaded once on first spawn of each role and cached. The
 * prompt is prepended to the worker's `taskPrompt` so every backend gets
 * role-mode behavior without per-backend changes — the LLM sees the
 * role instructions as the first thing in its task input.
 *
 * **Why files instead of inline strings**: prompts are content, not code.
 * They get edited and tuned independently of release cycles, sometimes
 * by non-engineers. Hardcoding them in TS would force a typecheck/build
 * round-trip on every prompt tweak and bury the content under quoting
 * noise. Files also let `git diff` show the actual prose change.
 */
const ROLE_SYSTEM_PROMPT_PATHS: Record<'planner' | 'coder', string> = {
  planner: 'prompts/cluster/planner-system.md',
  coder: 'prompts/cluster/executor-system.md',
};

export class WorkerPool {
  private workers = new Map<string, WorkerInstance>();
  /** FIFO history of exited worker instances; capped at RECENTLY_EXITED_MAX. */
  private recentlyExited: WorkerInstance[] = [];
  private backends = new Map<string, WorkerBackend>();
  private paused = false;
  private running = false;
  private taskCompletedCallback: TaskCompletedCallback | null = null;
  private taskProgressCallback: TaskProgressCallback | null = null;
  /**
   * Lazy-loaded role system prompt content, keyed by worker role.
   * Each entry: `null` = not yet attempted, `''` = loaded but missing /
   * empty (warned once), populated string = ready. On a missing file the
   * worker still runs without the role preamble — degraded behavior but
   * the cluster doesn't crash.
   */
  private rolePromptCache: Record<'planner' | 'coder', string | null> = {
    planner: null,
    coder: null,
  };

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

  /** Optional: persist partial stdout while the subprocess is still running. */
  setTaskProgressCallback(cb: TaskProgressCallback | null): void {
    this.taskProgressCallback = cb;
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
   * Spawn a new worker for a task. The worker's role in WorkerRegistry is
   * derived from the template's `role` field (Phase 3): templates marked
   * `role: 'planner'` register as planner workers, everything else (including
   * pre-Phase-3 templates with no role) registers as `coder`. The role is
   * what gates `hub_spawn` / `hub_query_task` / `hub_wait_task` access.
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

    // Phase 3: derive WorkerRegistry role from template config. Defaults to
    // 'coder' for backwards compat with Phase-1/2 executor-only templates.
    const role: 'coder' | 'planner' = template.role === 'planner' ? 'planner' : 'coder';

    // Phase 3: prepend the role-specific system prompt to the task
    // description. Both planner and executor (coder) get a role preamble
    // loaded from prompts/cluster/<role>-system.md. We mutate `taskPrompt`
    // for the spawn call only — the persisted TaskRecord.description is
    // unchanged so the WebUI / DB still show the user's original ticket
    // text without the boilerplate. Backend-agnostic: every backend just
    // passes taskPrompt through to its CLI, so prefixing here works
    // uniformly without touching ClaudeCli/Codex/Gemini/Minimax individually.
    const rolePrompt = await this.loadRoleSystemPrompt(role, projectPath);
    const effectivePrompt = rolePrompt ? `${rolePrompt}\n\n${task.description}` : task.description;

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
    // Stamp the taskId onto the registration so hub_report can look it up
    // without requiring a prior hub_claim call. Pre-Phase-2-round-2 this
    // only happened inside handleClaim(setTask), which meant any hub_report
    // without a preceding hub_claim would arrive at ContextHub with
    // `reg.currentTaskId === undefined` and skip the reportCallback
    // fast-path entirely.
    this.hub.workerRegistry.setTask(workerId, task.id);
    this.hub.eventLog.append('worker_joined', workerId, {
      template: templateName,
      project,
      taskId: task.id,
    });

    try {
      const proc = await backend.spawn({
        workerId,
        taskPrompt: effectivePrompt,
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
          `[WorkerPool] Worker ${worker.id} appears stuck (no hub_report for ${Math.round((now - worker.lastReport) / 1000)}s)`,
        );
        stuckWorkers.push(worker.id);
      }
    }

    return stuckWorkers;
  }

  /**
   * Update lastReport timestamp for a worker. Called from ContextHub on every
   * successful hub_report (via heartbeat callback) so healthCheck measures time
   * since last report, not time since process spawn.
   */
  updateLastReport(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastReport = Date.now();
    }
  }

  // ── Private ──

  /**
   * Kill a worker subprocess with escalation + force-cleanup.
   *
   * Normal path: SIGTERM → monitorProcess sees `proc.exited` resolve →
   * cleanup (status update, hub notification, recordExited, callback).
   *
   * Failure modes we defend against:
   *   1. CLI ignores SIGTERM (node apps stuck in fetch/stdin read) → after
   *      3s we escalate to SIGKILL, both via Bun's proc handle and a raw
   *      `process.kill(pid, ...)` fallback in case the handle is stale.
   *   2. Bun subprocess handle is broken (PPID=1 orphan from a prior bot
   *      crash — `proc.exited` never resolves) → after 8s we run
   *      `forceCleanup` which performs the same teardown as monitorProcess,
   *      relying on existing idempotency (`recordExited`, `markTaskCompleted`)
   *      to stay safe if monitorProcess does eventually fire later.
   *
   * Idempotent: re-entering on a worker already being killed is a no-op.
   */
  private async killWorkerInstance(worker: WorkerInstance): Promise<void> {
    if (worker.status === 'stopping' || worker.status === 'exited') return;
    worker.status = 'stopping';

    const proc = worker.process;
    const pid = proc?.pid;

    const sendSignal = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      try {
        proc?.kill(signal);
      } catch {
        // Handle may already be invalid; fall through to raw pid kill.
      }
      if (pid) {
        try {
          process.kill(pid, signal);
        } catch {
          // Process already dead.
        }
      }
    };

    sendSignal('SIGTERM');

    const sigkillTimer = setTimeout(() => {
      if (!this.workers.has(worker.id)) return;
      logger.warn(`[WorkerPool] Worker ${worker.id} did not exit on SIGTERM; escalating to SIGKILL`);
      sendSignal('SIGKILL');
    }, 3000);

    const forceCleanupTimer = setTimeout(() => {
      if (!this.workers.has(worker.id)) return;
      logger.warn(
        `[WorkerPool] Worker ${worker.id} monitor did not finalize after kill; force-cleaning state (process handle likely stale)`,
      );
      void this.forceCleanup(worker, 'Worker killed by user (force-cleaned after timeout)');
    }, 8000);

    if (proc) {
      void (proc.exited as unknown as Promise<unknown>)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(sigkillTimer);
          clearTimeout(forceCleanupTimer);
        });
    }
  }

  /**
   * Tear down a worker's state when `monitorProcess` can't (stale Bun
   * subprocess handle, proc.exited never resolves). Mirrors the
   * teardown sequence in monitorProcess and relies on the same
   * idempotency guarantees — if monitorProcess later fires for this
   * same worker, recordExited/markTaskCompleted both no-op.
   */
  private async forceCleanup(worker: WorkerInstance, reason: string): Promise<void> {
    if (!this.workers.has(worker.id)) return;

    worker.status = 'exited';
    worker.process = null;
    this.hub.workerExited(worker.id);

    if (worker.currentTask) {
      const task = worker.currentTask;
      const alreadyTerminal = task.status === 'completed' || task.status === 'failed';
      if (!alreadyTerminal) {
        task.status = 'failed';
        task.error = reason;
        task.completedAt = new Date().toISOString();
      }
    }

    this.recordExited(worker);

    if (worker.currentTask && this.taskCompletedCallback) {
      try {
        await this.taskCompletedCallback(worker.currentTask);
      } catch (err) {
        logger.error(`[WorkerPool] taskCompletedCallback threw during forceCleanup for ${worker.id}:`, err);
      }
    }
  }

  private async monitorProcess(worker: WorkerInstance, proc: import('bun').Subprocess): Promise<void> {
    // Collect stdout (best-effort; stream may close mid-read on kill).
    let rawOutput = '';
    const progressIntervalMs = 2000;
    let lastProgressFlush = 0;
    if (proc.stdout) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          rawOutput += decoder.decode(value, { stream: true });
          if (worker.currentTask) {
            worker.currentTask.output = rawOutput;
            const now = Date.now();
            if (this.taskProgressCallback && now - lastProgressFlush >= progressIntervalMs) {
              lastProgressFlush = now;
              try {
                await Promise.resolve(this.taskProgressCallback(worker.currentTask));
              } catch (err) {
                logger.warn(`[WorkerPool] taskProgressCallback threw for worker ${worker.id}:`, err);
              }
            }
          }
        }
      } catch {
        // Stream closed
      }
    }

    // Wait for exit.
    const exitCode = await proc.exited;

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
      // **Don't downgrade a terminal status set by hub_report**.
      // Phase 2 round 2 lets workers voluntarily declare done via
      // hub_report → reportCallback → markTaskCompleted before the
      // process actually exits. If the e2e script (or any other observer)
      // then calls cluster.stop(), the resulting SIGTERM produces a
      // non-zero exit code (e.g. 143) which would otherwise flip the
      // task back to `failed` here, racing with the fast-path mark.
      // Treat any prior terminal status as authoritative.
      const alreadyTerminal = worker.currentTask.status === 'completed' || worker.currentTask.status === 'failed';
      if (!alreadyTerminal) {
        worker.currentTask.status = exitCode === 0 ? 'completed' : 'failed';
        worker.currentTask.completedAt = new Date().toISOString();
        if (exitCode !== 0) {
          worker.currentTask.error = `Process exited with code ${exitCode}`;
        }
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

  /**
   * Lazy-load the role-specific system prompt from disk and cache it.
   * Both `'planner'` and `'coder'` (executor) roles get a preamble loaded
   * from `prompts/cluster/<role>-system.md`. First spawn of each role pays
   * the file IO; subsequent spawns of that role reuse the cached string.
   *
   * Resolution order (per role):
   *   1. `<projectPath>/prompts/cluster/<role>-system.md` — per-project
   *      override (rare; for projects that want to customize role behavior)
   *   2. `process.cwd()/prompts/cluster/<role>-system.md` — repo default
   *
   * If neither exists, returns empty string and logs once. The worker
   * still runs but without the role preamble — degraded behavior but the
   * cluster doesn't crash. Better than failing the whole spawn over a
   * missing prompt file.
   */
  private async loadRoleSystemPrompt(role: 'planner' | 'coder', projectPath: string): Promise<string> {
    const cached = this.rolePromptCache[role];
    if (cached !== null) return cached;

    const relativePath = ROLE_SYSTEM_PROMPT_PATHS[role];
    const candidates = [resolvePath(projectPath, relativePath), resolvePath(process.cwd(), relativePath)];
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf-8');
        logger.info(`[WorkerPool] Loaded ${role} system prompt from ${path} (${content.length} chars)`);
        this.rolePromptCache[role] = content;
        return content;
      } catch {
        // try next candidate
      }
    }
    logger.warn(
      `[WorkerPool] ${role} system prompt not found at any candidate path: ${candidates.join(', ')}. ` +
        `${role} workers will run without a role preamble.`,
    );
    this.rolePromptCache[role] = '';
    return '';
  }

  private async generateMCPConfig(workerId: string, hubUrl: string): Promise<string> {
    // Generate a temporary MCP config file that points to our ContextHub.
    // Format is Claude CLI's `--mcp-config` shape (mcpServers object).
    //
    // The `url` MUST include the `/mcp` suffix because that's where
    // HubMCPServer's WebStandardStreamableHTTPServerTransport is mounted
    // inside ContextHub.handleRequest. Without /mcp the worker would hit
    // the legacy /hub/* REST stubs which don't speak MCP protocol.
    //
    // The `X-Worker-Id` header is sent on every request the MCP client
    // makes, and the hub reads it from `extra.requestInfo.headers` inside
    // each tool handler to identify the caller — no session table needed.
    const mcpConfig = {
      mcpServers: {
        'cluster-context-hub': {
          type: 'http',
          url: `${hubUrl}/mcp`,
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
