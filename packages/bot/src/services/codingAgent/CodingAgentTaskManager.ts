/**
 * Coding-agent task manager: task records, the per-project queue, prompt
 * rendering and process lifecycle. Which CLI runs a task is the only thing
 * delegated to its executor.
 */

import { spawn } from 'bun';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { CodingAgentConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { randomUUID } from '@/utils/randomUUID';
import type { AgentExecutor } from './executors';
import type { AgentInvocation } from './executors/AgentExecutor';
import type { AgentExecutorName, AgentTask, AgentTaskType, ProjectContext, TaskNotification } from './types';

type TaskUpdateCallback = (task: AgentTask) => void;

/** `codex exec` writes its whole transcript to stderr, so only the tail says why it failed. */
const MAX_ERROR_CHARS = 2000;

export interface CreateTaskOptions {
  executor: AgentExecutorName;
  taskType?: AgentTaskType;
  projectContext?: ProjectContext;
  /** When true, the global handleTaskUpdate callback will skip sending result messages */
  suppressDefaultNotification?: boolean;
}

export class CodingAgentTaskManager {
  private tasks = new Map<string, AgentTask>();
  private runningProcesses = new Map<string, import('bun').Subprocess>();
  private cancelledTasks = new Set<string>();
  private taskUpdateCallback: TaskUpdateCallback | null = null;
  private promptManager: PromptManager | null = null;

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
  ) {}

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

      this.runningProcesses.set(taskId, proc);

      // Both pipes are drained at once: a CLI that fills the stderr pipe
      // buffer while stdout is still open blocks forever otherwise.
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      this.runningProcesses.delete(taskId);

      if (this.cancelledTasks.delete(taskId)) {
        task.status = 'failed';
        task.error = 'Task cancelled';
        logger.info(`[CodingAgentTaskManager] Running task ${taskId} cancelled`);
      } else if (exitCode === 0) {
        task.status = 'completed';
        task.result = stdout || 'Task completed successfully';
        logger.info(`[CodingAgentTaskManager] Task ${taskId} completed`);
      } else {
        task.status = 'failed';
        task.error = stderr.trim().slice(-MAX_ERROR_CHARS) || `Process exited with code ${exitCode}`;
        logger.error(`[CodingAgentTaskManager] Task ${taskId} failed: ${task.error}`);
      }
    } catch (error) {
      this.runningProcesses.delete(taskId);
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
   * Handle task notification from the agent CLI
   */
  handleTaskNotification(notification: TaskNotification): void {
    const task = this.tasks.get(notification.taskId);
    if (!task) {
      logger.warn(`[CodingAgentTaskManager] Received notification for unknown task: ${notification.taskId}`);
      return;
    }

    // Update task based on notification
    switch (notification.status) {
      case 'started':
        task.status = 'running';
        this.notifyTaskUpdate(task);
        break;
      case 'progress':
        // Keep running status, just log progress
        logger.debug(
          `[CodingAgentTaskManager] Task ${task.id} progress: ${notification.progress}% - ${notification.message}`,
        );
        this.notifyTaskUpdate(task);
        break;
      case 'completed':
        // Only update state here; don't trigger notification callback.
        // executeTask() will send the final notification with full stdout output.
        task.status = 'completed';
        task.result = notification.result || notification.message;
        break;
      case 'failed':
        // Same as completed: let executeTask() handle the final notification.
        task.status = 'failed';
        task.error = notification.error || notification.message;
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

    // A running task is finalized by executeTask once its process exits, so
    // the notification and queue advance happen exactly once.
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      this.cancelledTasks.add(taskId);
      proc.kill();
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
