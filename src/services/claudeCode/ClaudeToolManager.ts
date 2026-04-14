/**
 * Claude Task Manager
 *
 * Manages Claude Code CLI tasks triggered by the bot.
 * Handles task queue, execution, and result collection.
 */

import { type Subprocess, spawn } from 'bun';
import { randomUUID } from '@/utils/randomUUID';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { logger } from '@/utils/logger';
import type { ClaudeTask, ClaudeTaskType, MCPServerConfig, ProjectContext, TaskNotification } from '../mcpServer/types';

type TaskUpdateCallback = (task: ClaudeTask) => void;

export interface CreateTaskOptions {
  taskType?: ClaudeTaskType;
  projectContext?: ProjectContext;
  /** When true, the global handleTaskUpdate callback will skip sending result messages */
  suppressDefaultNotification?: boolean;
}

export class ClaudeToolManager {
  private config: MCPServerConfig;
  private tasks = new Map<string, ClaudeTask>();
  private runningProcesses = new Map<string, Subprocess>();
  private taskUpdateCallback: TaskUpdateCallback | null = null;
  private promptManager: PromptManager | null = null;

  // Per-project queue: projectKey → ordered list of pending task IDs
  private projectQueues = new Map<string, string[]>();
  // Per-project running task: projectKey → currently running task ID
  private projectRunningTask = new Map<string, string>();
  // Per-task completion resolvers for awaitTaskCompletion()
  private taskCompletionResolvers = new Map<string, (task: ClaudeTask) => void>();

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /**
   * Set PromptManager for template rendering
   */
  setPromptManager(promptManager: PromptManager): void {
    this.promptManager = promptManager;
    logger.info('[ClaudeToolManager] PromptManager set');
  }

  /**
   * Process prompt template with variables using PromptManager.
   * Dynamically selects template based on task type and project context.
   */
  private processPromptTemplate(task: ClaudeTask): string {
    if (!this.promptManager) {
      logger.warn('[ClaudeToolManager] PromptManager not set, using raw prompt');
      return task.prompt;
    }

    const mcpApiUrl = `http://${this.config.host || '127.0.0.1'}:${this.config.port}`;
    const ctx = task.projectContext;

    // Determine template key
    let templateKey: string;
    if (ctx?.promptTemplateKey) {
      templateKey = ctx.promptTemplateKey;
    } else if (task.taskType === 'new-project') {
      templateKey = 'claude-code.task.new-project';
    } else if (ctx) {
      // Has project context → try project-specific template, then generic
      const projectSpecificKey = `claude-code.task.${ctx.alias}`;
      templateKey = this.promptManager.getTemplate(projectSpecificKey)
        ? projectSpecificKey
        : 'claude-code.task.generic';
    } else {
      // No project context → use default qqbot template
      templateKey = 'claude-code.task';
    }

    // Final fallback to existing claude-code.task if chosen template doesn't exist
    if (!this.promptManager.getTemplate(templateKey)) {
      templateKey = 'claude-code.task';
    }

    const projectType = ctx?.type || 'generic';
    const variables: Record<string, string> = {
      taskId: task.id,
      userPrompt: task.prompt,
      workingDirectory: task.workingDirectory || process.cwd(),
      mcpApiUrl,
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
      logger.warn('[ClaudeToolManager] Failed to render template, using raw prompt:', error);
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
   * Create a new Claude Code task
   */
  createTask(
    prompt: string,
    requestedBy: ClaudeTask['requestedBy'],
    workingDirectory?: string,
    options?: CreateTaskOptions,
  ): ClaudeTask {
    const task: ClaudeTask = {
      id: randomUUID(),
      prompt,
      workingDirectory: workingDirectory || this.config.workingDirectory,
      createdAt: new Date(),
      status: 'pending',
      requestedBy,
      taskType: options?.taskType || 'dev',
      projectContext: options?.projectContext,
      suppressDefaultNotification: options?.suppressDefaultNotification,
    };

    this.tasks.set(task.id, task);
    logger.info(`[ClaudeToolManager] Task created: ${task.id} (type: ${task.taskType})`);
    return task;
  }

  /**
   * Get project key from a task's working directory.
   * Tasks with the same project key are serialized.
   */
  private getProjectKey(task: ClaudeTask): string {
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
        logger.error(`[ClaudeToolManager] Task execution error:`, error);
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
    logger.info(`[ClaudeToolManager] Task ${taskId} queued for project ${projectKey} (position: ${position})`);
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

    logger.info(`[ClaudeToolManager] Starting next queued task ${nextTaskId} for project ${projectKey}`);
    this.projectRunningTask.set(projectKey, nextTaskId);
    this.executeTask(nextTaskId).catch((error) => {
      logger.error(`[ClaudeToolManager] Queued task execution error:`, error);
    });
  }

  /**
   * Execute a Claude Code task.
   * Called internally by enqueueTask — do not call directly.
   */
  async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const cliPath = this.config.claudeCliPath || 'claude';
    const workDir = task.workingDirectory || process.cwd();

    // Process prompt template with variables
    const processedPrompt = this.processPromptTemplate(task);

    // Build Claude Code command
    // Using --print flag to output result and exit
    // Using --dangerously-skip-permissions to bypass permission prompts (bot can't interact)
    // Pass task ID via environment so Claude can use notify_task_status
    const args = [
      '--print', // Non-interactive mode, print result
      '--dangerously-skip-permissions', // Skip permission prompts
      '--output-format',
      'text',
      processedPrompt,
    ];

    logger.info(`[ClaudeToolManager] Executing task ${taskId}: ${cliPath} ${args.join(' ')}`);

    task.status = 'running';
    this.notifyTaskUpdate(task);

    try {
      const proc = spawn({
        cmd: [cliPath, ...args],
        cwd: workDir,
        env: {
          ...process.env,
          CLAUDE_TASK_ID: taskId,
          CLAUDE_MCP_SERVER_URL: `http://${this.config.host || '127.0.0.1'}:${this.config.port}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      this.runningProcesses.set(taskId, proc);

      // Collect output
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      // Read stdout
      if (proc.stdout) {
        const reader = proc.stdout.getReader();
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

      // Read stderr
      if (proc.stderr) {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stderrChunks.push(decoder.decode(value, { stream: true }));
          }
        } catch {
          // Stream closed
        }
      }

      const exitCode = await proc.exited;
      this.runningProcesses.delete(taskId);

      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      if (exitCode === 0) {
        task.status = 'completed';
        task.result = stdout || 'Task completed successfully';
        logger.info(`[ClaudeToolManager] Task ${taskId} completed`);
      } else {
        task.status = 'failed';
        task.error = stderr || `Process exited with code ${exitCode}`;
        logger.error(`[ClaudeToolManager] Task ${taskId} failed: ${task.error}`);
      }

      this.notifyTaskUpdate(task);

      // Process next queued task for this project
      const projectKey = this.getProjectKey(task);
      this.processNextInQueue(projectKey);
    } catch (error) {
      this.runningProcesses.delete(taskId);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      logger.error(`[ClaudeToolManager] Task ${taskId} error:`, error);
      this.notifyTaskUpdate(task);

      // Process next queued task for this project even on error
      const projectKey = this.getProjectKey(task);
      this.processNextInQueue(projectKey);
    }
  }

  /**
   * Handle task notification from Claude Code
   */
  handleTaskNotification(notification: TaskNotification): void {
    const task = this.tasks.get(notification.taskId);
    if (!task) {
      logger.warn(`[ClaudeToolManager] Received notification for unknown task: ${notification.taskId}`);
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
          `[ClaudeToolManager] Task ${task.id} progress: ${notification.progress}% - ${notification.message}`,
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
  getTask(taskId: string): ClaudeTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): ClaudeTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Cancel a running or queued task
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    const projectKey = this.getProjectKey(task);

    // Check if it's a running task
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      proc.kill();
      this.runningProcesses.delete(taskId);

      task.status = 'failed';
      task.error = 'Task cancelled';
      this.notifyTaskUpdate(task);

      // Process next queued task for this project
      this.processNextInQueue(projectKey);

      logger.info(`[ClaudeToolManager] Running task ${taskId} cancelled`);
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

        logger.info(`[ClaudeToolManager] Queued task ${taskId} cancelled`);
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
  awaitTaskCompletion(taskId: string): Promise<ClaudeTask> {
    const task = this.tasks.get(taskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) {
      return Promise.resolve(task);
    }
    return new Promise<ClaudeTask>((resolve) => {
      this.taskCompletionResolvers.set(taskId, resolve);
    });
  }

  private notifyTaskUpdate(task: ClaudeTask): void {
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
