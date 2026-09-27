/**
 * Coding-agent task manager: task records, the per-project queue, prompt
 * rendering and process lifecycle. Which CLI runs a task is the only thing
 * delegated to its executor.
 */

import { type Subprocess, spawn } from 'bun';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { CodingAgentConfig } from '@/core/config';
import { parseDuration } from '@/utils/duration';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
import type { AgentExecutor } from './executors';
import type { AgentInvocation } from './executors/AgentExecutor';
import type { AgentExecutorName, AgentTask, AgentTaskType, ProjectContext, TaskNotification } from './types';

type TaskUpdateCallback = (task: AgentTask) => void;

export interface TaskProgressUpdate {
  status: 'started' | 'progress';
  message: string;
  progress?: number;
}
type TaskProgressCallback = (task: AgentTask, update: TaskProgressUpdate) => void;

/** `codex exec` writes its whole transcript to stderr, so only the tail says why it failed. */
const MAX_ERROR_CHARS = 2000;

const DEFAULT_IDLE_TIMEOUT = '15m';
const DEFAULT_TIMEOUT = '3h';
const MAX_WATCHDOG_INTERVAL_MS = 30_000;
/** Node-based CLIs can sit on SIGTERM while blocked in a fetch; escalate after this long. */
const KILL_ESCALATION_MS = 5_000;
/**
 * Commands the CLI started inherit its stdout/stderr and can keep them open
 * after the CLI itself exits, so EOF is only awaited this long past exit.
 */
const STREAM_DRAIN_GRACE_MS = 2_000;

interface RunningProcess {
  proc: Subprocess<'ignore' | Blob, 'pipe', 'pipe'>;
  startedAt: number;
  /** Last stdout/stderr output or MCP request from the task. */
  lastActivity: number;
  /** Why the bot killed the process; set once, read when the process exits. */
  termination?: string;
}

interface OutputCollector {
  done: Promise<void>;
  text(): string;
  cancel(): void;
}

function collectOutput(stream: ReadableStream<Uint8Array>, onActivity: () => void): OutputCollector {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) {
          return;
        }
        chunks.push(decoder.decode(value, { stream: true }));
        onActivity();
      }
    } catch {
      // Reader cancelled after the drain grace period.
    }
  })();
  return {
    done,
    text: () => chunks.join(''),
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)} 分钟`;
}

export interface CreateTaskOptions {
  executor: AgentExecutorName;
  model: string;
  effort?: string;
  taskType?: AgentTaskType;
  projectContext?: ProjectContext;
  /** When true, the global handleTaskUpdate callback will skip sending result messages */
  suppressDefaultNotification?: boolean;
}

export class CodingAgentTaskManager {
  private tasks = new Map<string, AgentTask>();
  private running = new Map<string, RunningProcess>();
  private taskUpdateCallback: TaskUpdateCallback | null = null;
  private taskProgressCallback: TaskProgressCallback | null = null;
  private promptManager: PromptManager | null = null;
  private readonly idleTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly watchdogIntervalMs: number;

  // Per-project queue: projectKey → ordered list of pending task IDs
  private projectQueues = new Map<string, string[]>();
  // Per-project running task: projectKey → currently running task ID
  private projectRunningTask = new Map<string, string>();
  // Per-task completion resolvers for awaitTaskCompletion()
  private taskCompletionResolvers = new Map<string, (task: AgentTask) => void>();

  constructor(
    private readonly config: CodingAgentConfig,
    private readonly executors: Record<AgentExecutorName, AgentExecutor>,
    private readonly mcpUrl: string,
  ) {
    this.idleTimeoutMs = parseDuration(config.idleTimeout || DEFAULT_IDLE_TIMEOUT);
    this.timeoutMs = parseDuration(config.timeout || DEFAULT_TIMEOUT);
    this.watchdogIntervalMs = Math.min(MAX_WATCHDOG_INTERVAL_MS, this.idleTimeoutMs / 2, this.timeoutMs / 2);
  }

  /**
   * Set PromptManager for template rendering
   */
  setPromptManager(promptManager: PromptManager): void {
    this.promptManager = promptManager;
    logger.info('[CodingAgentTaskManager] PromptManager set');
  }

  /**
   * Process prompt template with variables using PromptManager.
   * Dynamically selects template based on task type and project context.
   */
  private processPromptTemplate(task: AgentTask): string {
    if (!this.promptManager) {
      logger.warn('[CodingAgentTaskManager] PromptManager not set, using raw prompt');
      return task.prompt;
    }

    const ctx = task.projectContext;

    // Determine template key
    let templateKey: string;
    if (ctx?.promptTemplateKey) {
      templateKey = ctx.promptTemplateKey;
    } else if (task.taskType === 'new-project') {
      templateKey = 'coding-agent.task.new-project';
    } else if (ctx) {
      // Has project context → try project-specific template, then generic
      const projectSpecificKey = `coding-agent.task.${ctx.alias}`;
      templateKey = this.promptManager.getTemplate(projectSpecificKey)
        ? projectSpecificKey
        : 'coding-agent.task.generic';
    } else {
      // No project context → use default qqbot template
      templateKey = 'coding-agent.task';
    }

    // Final fallback to existing coding-agent.task if chosen template doesn't exist
    if (!this.promptManager.getTemplate(templateKey)) {
      templateKey = 'coding-agent.task';
    }

    const projectType = ctx?.type || 'generic';
    const executor = this.executors[task.executor];
    const variables: Record<string, string> = {
      taskId: task.id,
      agentName: executor.displayName,
      coAuthorTrailer: executor.coAuthorTrailer,
      userPrompt: task.prompt,
      workingDirectory: task.workingDirectory || process.cwd(),
      targetType: task.requestedBy.type,
      targetId: task.requestedBy.id,
      projectDescription: ctx?.description || '未知项目',
      projectType,
      hasClaudeMd: ctx?.hasClaudeMd ? 'true' : '',
      qualityCheckCommands: this.getQualityCheckCommands(projectType),
    };

    try {
      variables.progressProtocol = this.promptManager.render('coding-agent.progress-protocol', variables);
      return this.promptManager.render(templateKey, variables);
    } catch (error) {
      logger.warn('[CodingAgentTaskManager] Failed to render template, using raw prompt:', error);
      return task.prompt;
    }
  }

  /**
   * Set callback for task updates
   */
  setTaskUpdateCallback(callback: TaskUpdateCallback): void {
    this.taskUpdateCallback = callback;
  }

  /**
   * Set callback for the started / progress reports an agent sends mid-task
   */
  setTaskProgressCallback(callback: TaskProgressCallback): void {
    this.taskProgressCallback = callback;
  }

  /**
   * Record that a running task is alive (it called the MCP server).
   */
  touch(taskId: string): void {
    const running = this.running.get(taskId);
    if (running) {
      running.lastActivity = Date.now();
    }
  }

  /**
   * Create a new coding-agent task
   */
  createTask(
    prompt: string,
    requestedBy: AgentTask['requestedBy'],
    workingDirectory: string | undefined,
    options: CreateTaskOptions,
  ): AgentTask {
    const task: AgentTask = {
      id: randomUUID(),
      executor: options.executor,
      model: options.model,
      effort: options.effort,
      prompt,
      workingDirectory: workingDirectory || this.config.workingDirectory,
      createdAt: new Date(),
      status: 'pending',
      requestedBy,
      taskType: options.taskType || 'dev',
      projectContext: options.projectContext,
      suppressDefaultNotification: options.suppressDefaultNotification,
    };

    this.tasks.set(task.id, task);
    logger.info(
      `[CodingAgentTaskManager] Task created: ${task.id} (executor: ${task.executor}, type: ${task.taskType})`,
    );
    return task;
  }

  /**
   * Get project key from a task's working directory.
   * Tasks with the same project key are serialized, whichever executor runs
   * them, because they would otherwise edit the same working tree at once.
   */
  private getProjectKey(task: AgentTask): string {
    return task.workingDirectory || this.config.workingDirectory || process.cwd();
  }

  /**
   * Get current running task count
   */
  getRunningTaskCount(): number {
    return this.projectRunningTask.size;
  }

  /**
   * Get total pending (queued) task count across all projects
   */
  getPendingTaskCount(): number {
    let count = 0;
    for (const queue of this.projectQueues.values()) {
      count += queue.length;
    }
    return count;
  }

  /**
   * Get queue info per project
   */
  getQueueInfo(): Array<{ project: string; running: string | null; queued: number }> {
    const projects = new Set<string>();
    for (const key of this.projectRunningTask.keys()) projects.add(key);
    for (const key of this.projectQueues.keys()) projects.add(key);

    return Array.from(projects).map((project) => ({
      project,
      running: this.projectRunningTask.get(project) || null,
      queued: this.projectQueues.get(project)?.length || 0,
    }));
  }

  /**
   * Enqueue a task for execution. If no task is running for its project,
   * start it immediately. Otherwise, add it to the project's queue.
   */
  enqueueTask(taskId: string): { started: boolean; queuePosition: number } {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const projectKey = this.getProjectKey(task);

    // If no task is running for this project, start immediately
    if (!this.projectRunningTask.has(projectKey)) {
      this.projectRunningTask.set(projectKey, taskId);
      this.executeTask(taskId).catch((error) => {
        logger.error(`[CodingAgentTaskManager] Task execution error:`, error);
      });
      return { started: true, queuePosition: 0 };
    }

    // Otherwise, add to the project's queue
    let queue = this.projectQueues.get(projectKey);
    if (!queue) {
      queue = [];
      this.projectQueues.set(projectKey, queue);
    }
    queue.push(taskId);
    const position = queue.length;
    logger.info(`[CodingAgentTaskManager] Task ${taskId} queued for project ${projectKey} (position: ${position})`);
    return { started: false, queuePosition: position };
  }

  /**
   * Process the next queued task for a project after the current one finishes.
   */
  private processNextInQueue(projectKey: string): void {
    const queue = this.projectQueues.get(projectKey);
    if (!queue || queue.length === 0) {
      this.projectRunningTask.delete(projectKey);
      this.projectQueues.delete(projectKey);
      return;
    }

    const nextTaskId = queue.shift() as string;
    if (queue.length === 0) {
      this.projectQueues.delete(projectKey);
    }

    const nextTask = this.tasks.get(nextTaskId);
    if (!nextTask || nextTask.status === 'failed') {
      // Task was cancelled or invalid, skip to next
      this.processNextInQueue(projectKey);
      return;
    }

    logger.info(`[CodingAgentTaskManager] Starting next queued task ${nextTaskId} for project ${projectKey}`);
    this.projectRunningTask.set(projectKey, nextTaskId);
    this.executeTask(nextTaskId).catch((error) => {
      logger.error(`[CodingAgentTaskManager] Queued task execution error:`, error);
    });
  }

  /**
   * Execute a task with its executor.
   * Called internally by enqueueTask — do not call directly.
   */
  async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const workingDirectory = task.workingDirectory || process.cwd();
    task.status = 'running';
    this.notifyTaskUpdate(task);

    let invocation: AgentInvocation | undefined;
    try {
      invocation = await this.executors[task.executor].buildInvocation({
        task,
        prompt: this.processPromptTemplate(task),
        workingDirectory,
        mcpUrl: this.mcpUrl,
      });
      logger.info(`[CodingAgentTaskManager] Executing task ${taskId} with ${task.executor}: ${invocation.cmd[0]}`);

      const proc = spawn({
        cmd: invocation.cmd,
        cwd: workingDirectory,
        env: invocation.env,
        stdin: invocation.stdin === undefined ? 'ignore' : new Blob([invocation.stdin]),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const now = Date.now();
      const running: RunningProcess = { proc, startedAt: now, lastActivity: now };
      this.running.set(taskId, running);
      const markActive = () => {
        running.lastActivity = Date.now();
      };
      // Both pipes are drained at once: a CLI that fills the stderr pipe
      // buffer while stdout is still open blocks forever otherwise.
      const stdout = collectOutput(proc.stdout, markActive);
      const stderr = collectOutput(proc.stderr, markActive);
      const watchdog = setInterval(() => this.checkLiveness(taskId), this.watchdogIntervalMs);

      let exitCode: number;
      try {
        exitCode = await proc.exited;
        await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(STREAM_DRAIN_GRACE_MS)]);
      } finally {
        clearInterval(watchdog);
        stdout.cancel();
        stderr.cancel();
        this.running.delete(taskId);
      }

      if (running.termination) {
        task.status = 'failed';
        task.error = running.termination;
        logger.warn(`[CodingAgentTaskManager] Task ${taskId} terminated: ${running.termination}`);
      } else if (exitCode === 0) {
        task.status = 'completed';
        task.result = this.executors[task.executor].finalMessage(stdout.text()) || 'Task completed successfully';
        logger.info(`[CodingAgentTaskManager] Task ${taskId} completed`);
      } else {
        task.status = 'failed';
        task.error = stderr.text().trim().slice(-MAX_ERROR_CHARS) || `Process exited with code ${exitCode}`;
        logger.error(`[CodingAgentTaskManager] Task ${taskId} failed: ${task.error}`);
      }
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      logger.error(`[CodingAgentTaskManager] Task ${taskId} error:`, error);
    } finally {
      await invocation?.cleanup().catch((error) => {
        logger.warn(`[CodingAgentTaskManager] Cleanup for task ${taskId} failed:`, error);
      });
    }

    this.notifyTaskUpdate(task);
    this.processNextInQueue(this.getProjectKey(task));
  }

  /**
   * Kill a task that has been silent past the idle timeout or has run past
   * the total timeout. Output on either stream and MCP requests count as life.
   */
  private checkLiveness(taskId: string): void {
    const running = this.running.get(taskId);
    if (!running || running.termination) {
      return;
    }
    const now = Date.now();
    if (now - running.startedAt > this.timeoutMs) {
      this.terminate(taskId, `运行超过 ${formatMinutes(this.timeoutMs)}，已终止`);
    } else if (now - running.lastActivity > this.idleTimeoutMs) {
      this.terminate(taskId, `${formatMinutes(this.idleTimeoutMs)}内没有任何输出或回报，判定卡死，已终止`);
    }
  }

  /**
   * Kill a running task. executeTask finalizes it when the process exits, so
   * the notification and queue advance happen exactly once.
   */
  private terminate(taskId: string, reason: string): boolean {
    const running = this.running.get(taskId);
    if (!running) {
      return false;
    }
    if (running.termination) {
      return true;
    }
    running.termination = reason;
    running.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.running.get(taskId) === running) {
        running.proc.kill('SIGKILL');
      }
    }, KILL_ESCALATION_MS);
    return true;
  }

  /**
   * Handle task notification from the agent CLI
   */
  handleTaskNotification(notification: TaskNotification): void {
    const task = this.tasks.get(notification.taskId);
    if (!task) {
      logger.warn(`[CodingAgentTaskManager] Received notification for unknown task: ${notification.taskId}`);
      return;
    }

    this.touch(task.id);

    // The process exit is the only thing that finalizes a task, so a
    // completed / failed report is not applied: it would mark a task done
    // while its process is still running.
    switch (notification.status) {
      case 'started':
      case 'progress':
        if (notification.message && this.taskProgressCallback) {
          this.taskProgressCallback(task, {
            status: notification.status,
            message: notification.message,
            progress: notification.progress,
          });
        }
        break;
      case 'completed':
      case 'failed':
        logger.info(`[CodingAgentTaskManager] Task ${task.id} reported ${notification.status}; waiting for exit`);
        break;
    }
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): AgentTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Cancel a running or queued task
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    const projectKey = this.getProjectKey(task);

    if (this.terminate(taskId, 'Task cancelled')) {
      return true;
    }

    // Check if it's in a queue
    const queue = this.projectQueues.get(projectKey);
    if (queue) {
      const idx = queue.indexOf(taskId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        if (queue.length === 0) {
          this.projectQueues.delete(projectKey);
        }

        task.status = 'failed';
        task.error = 'Task cancelled';
        this.notifyTaskUpdate(task);

        logger.info(`[CodingAgentTaskManager] Queued task ${taskId} cancelled`);
        return true;
      }
    }

    return false;
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanupOldTasks(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if ((task.status === 'completed' || task.status === 'failed') && now - task.createdAt.getTime() > maxAgeMs) {
        this.tasks.delete(id);
      }
    }
  }

  /**
   * Await a task's completion. Returns a promise that resolves when the task
   * transitions to 'completed' or 'failed' status.
   */
  awaitTaskCompletion(taskId: string): Promise<AgentTask> {
    const task = this.tasks.get(taskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) {
      return Promise.resolve(task);
    }
    return new Promise<AgentTask>((resolve) => {
      this.taskCompletionResolvers.set(taskId, resolve);
    });
  }

  private notifyTaskUpdate(task: AgentTask): void {
    if (this.taskUpdateCallback) {
      this.taskUpdateCallback(task);
    }
    // Resolve per-task completion waiters
    if (task.status === 'completed' || task.status === 'failed') {
      const resolver = this.taskCompletionResolvers.get(task.id);
      if (resolver) {
        this.taskCompletionResolvers.delete(task.id);
        resolver(task);
      }
    }
  }

  /**
   * Get quality check commands based on project type
   */
  private getQualityCheckCommands(projectType: string): string {
    switch (projectType) {
      case 'bun':
        return 'bun run typecheck\nbun run lint\nbun test';
      case 'node':
        return 'npm run typecheck\nnpm run lint\nnpm test';
      case 'python':
        return 'ruff check .\nmypy .\npytest';
      case 'rust':
        return 'cargo check\ncargo clippy\ncargo test';
      default:
        return '# 根据项目配置运行合适的检查命令';
    }
  }
}
