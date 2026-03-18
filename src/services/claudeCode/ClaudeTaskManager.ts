/**
 * Claude Task Manager
 *
 * Manages Claude Code CLI tasks triggered by the bot.
 * Handles task queue, execution, and result collection.
 */

import { type Subprocess, spawn } from 'bun';
import { randomUUID } from 'crypto';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { logger } from '@/utils/logger';
import type { ClaudeTask, MCPServerConfig, TaskNotification } from '../mcpServer/types';

type TaskUpdateCallback = (task: ClaudeTask) => void;

export class ClaudeTaskManager {
  private config: MCPServerConfig;
  private tasks = new Map<string, ClaudeTask>();
  private runningProcesses = new Map<string, Subprocess>();
  private taskUpdateCallback: TaskUpdateCallback | null = null;
  private promptManager: PromptManager | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /**
   * Set PromptManager for template rendering
   */
  setPromptManager(promptManager: PromptManager): void {
    this.promptManager = promptManager;
    logger.info('[ClaudeTaskManager] PromptManager set');
  }

  /**
   * Process prompt template with variables using PromptManager
   */
  private processPromptTemplate(task: ClaudeTask): string {
    if (!this.promptManager) {
      logger.warn('[ClaudeTaskManager] PromptManager not set, using raw prompt');
      return task.prompt;
    }

    const mcpApiUrl = `http://${this.config.host || '127.0.0.1'}:${this.config.port}`;

    try {
      return this.promptManager.render('claude-code.task', {
        taskId: task.id,
        userPrompt: task.prompt,
        workingDirectory: task.workingDirectory || process.cwd(),
        mcpApiUrl,
        targetType: task.requestedBy.type,
        targetId: task.requestedBy.id,
      });
    } catch (error) {
      logger.warn('[ClaudeTaskManager] Failed to render template, using raw prompt:', error);
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
  createTask(prompt: string, requestedBy: ClaudeTask['requestedBy'], workingDirectory?: string): ClaudeTask {
    const task: ClaudeTask = {
      id: randomUUID(),
      prompt,
      workingDirectory: workingDirectory || this.config.workingDirectory,
      createdAt: new Date(),
      status: 'pending',
      requestedBy,
    };

    this.tasks.set(task.id, task);
    logger.info(`[ClaudeTaskManager] Task created: ${task.id}`);
    return task;
  }

  /**
   * Check if user is allowed to trigger tasks
   */
  isUserAllowed(userId: string): boolean {
    if (!this.config.allowedUsers || this.config.allowedUsers.length === 0) {
      return true; // No restrictions
    }
    return this.config.allowedUsers.includes(userId);
  }

  /**
   * Get current running task count
   */
  getRunningTaskCount(): number {
    return this.runningProcesses.size;
  }

  /**
   * Check if can start new task
   */
  canStartTask(): boolean {
    const maxConcurrent = this.config.maxConcurrentTasks || 1;
    return this.getRunningTaskCount() < maxConcurrent;
  }

  /**
   * Execute a Claude Code task
   */
  async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (!this.canStartTask()) {
      throw new Error('Max concurrent tasks reached');
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

    logger.info(`[ClaudeTaskManager] Executing task ${taskId}: ${cliPath} ${args.join(' ')}`);

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
        logger.info(`[ClaudeTaskManager] Task ${taskId} completed`);
      } else {
        task.status = 'failed';
        task.error = stderr || `Process exited with code ${exitCode}`;
        logger.error(`[ClaudeTaskManager] Task ${taskId} failed: ${task.error}`);
      }

      this.notifyTaskUpdate(task);
    } catch (error) {
      this.runningProcesses.delete(taskId);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      logger.error(`[ClaudeTaskManager] Task ${taskId} error:`, error);
      this.notifyTaskUpdate(task);
    }
  }

  /**
   * Handle task notification from Claude Code
   */
  handleTaskNotification(notification: TaskNotification): void {
    const task = this.tasks.get(notification.taskId);
    if (!task) {
      logger.warn(`[ClaudeTaskManager] Received notification for unknown task: ${notification.taskId}`);
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
          `[ClaudeTaskManager] Task ${task.id} progress: ${notification.progress}% - ${notification.message}`,
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
   * Get pending tasks count
   */
  getPendingTaskCount(): number {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'pending').length;
  }

  /**
   * Cancel a running task
   */
  cancelTask(taskId: string): boolean {
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      proc.kill();
      this.runningProcesses.delete(taskId);

      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'failed';
        task.error = 'Task cancelled';
        this.notifyTaskUpdate(task);
      }

      logger.info(`[ClaudeTaskManager] Task ${taskId} cancelled`);
      return true;
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

  private notifyTaskUpdate(task: ClaudeTask): void {
    if (this.taskUpdateCallback) {
      this.taskUpdateCallback(task);
    }
  }
}
