/**
 * Claude Code Service
 *
 * Main service that integrates MCP Server and Claude Task Manager with the bot.
 * Provides a unified interface for:
 * - Starting/stopping the MCP server
 * - Triggering Claude Code tasks from bot commands
 * - Sending task results back to users
 */

import { spawn } from 'bun';
import type { APIClient } from '@/api/APIClient';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProtocolName } from '@/core/config';
import { logger } from '@/utils/logger';
import { ClaudeTaskManager } from './ClaudeTaskManager';
import { MCPServer } from './MCPServer';
import type {
  ClaudeTask,
  ExecuteCommandParams,
  ExecuteCommandResult,
  MCPServerConfig,
  SendMessageParams,
} from './types';

interface SendMessageResult {
  message_id?: number;
  message_seq?: number;
}

export class ClaudeCodeService {
  private config: MCPServerConfig;
  private mcpServer: MCPServer;
  private taskManager: ClaudeTaskManager;
  private apiClient: APIClient | null = null;
  private botStartTime: number;
  private connectedProtocols: ProtocolName[] = [];
  private selfId: string | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.mcpServer = new MCPServer(config);
    this.taskManager = new ClaudeTaskManager(config);
    this.botStartTime = Date.now();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle task notifications from Claude Code
    this.mcpServer.setTaskNotificationHandler((notification) => {
      this.taskManager.handleTaskNotification(notification);
    });

    // Handle send message requests from Claude Code
    this.mcpServer.setSendMessageHandler(async (params) => {
      return await this.sendMessage(params);
    });

    // Handle bot info requests
    this.mcpServer.setBotInfoHandler(() => ({
      selfId: this.selfId,
      connectedProtocols: this.connectedProtocols,
      uptime: Date.now() - this.botStartTime,
      taskQueue: {
        pending: this.taskManager.getPendingTaskCount(),
        running: this.taskManager.getRunningTaskCount(),
      },
    }));

    // Handle task updates - send results back to users
    this.taskManager.setTaskUpdateCallback((task) => {
      this.handleTaskUpdate(task);
    });

    // Handle command execution requests from Claude Code
    this.mcpServer.setExecuteCommandHandler(async (params) => {
      return await this.executeCommand(params);
    });
  }

  /**
   * Set API client for sending messages
   */
  setAPIClient(apiClient: APIClient): void {
    this.apiClient = apiClient;
  }

  /**
   * Set PromptManager for template rendering
   */
  setPromptManager(promptManager: PromptManager): void {
    this.taskManager.setPromptManager(promptManager);
  }

  /**
   * Update bot info
   */
  updateBotInfo(selfId: string | null, protocols: ProtocolName[]): void {
    this.selfId = selfId;
    this.connectedProtocols = protocols;
  }

  /**
   * Start the service
   */
  async start(): Promise<string> {
    const url = await this.mcpServer.start();
    logger.info(`[ClaudeCodeService] Service started. MCP Server URL: ${url}`);
    return url;
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    await this.mcpServer.stop();
    logger.info('[ClaudeCodeService] Service stopped');
  }

  /**
   * Check if user can trigger Claude Code tasks
   */
  canUserTriggerTask(userId: string): boolean {
    return this.taskManager.isUserAllowed(userId);
  }

  /**
   * Trigger a Claude Code task
   */
  async triggerTask(
    prompt: string,
    requestedBy: ClaudeTask['requestedBy'],
    workingDirectory?: string,
  ): Promise<ClaudeTask> {
    if (!this.taskManager.canStartTask()) {
      throw new Error('Too many concurrent tasks. Please wait for current tasks to complete.');
    }

    const task = this.taskManager.createTask(prompt, requestedBy, workingDirectory);

    // Execute task in background
    this.taskManager.executeTask(task.id).catch((error) => {
      logger.error(`[ClaudeCodeService] Task execution error:`, error);
    });

    return task;
  }

  /**
   * Get task status
   */
  getTask(taskId: string): ClaudeTask | undefined {
    return this.taskManager.getTask(taskId);
  }

  /**
   * Cancel a running task
   */
  cancelTask(taskId: string): boolean {
    return this.taskManager.cancelTask(taskId);
  }

  /**
   * Send message via bot API
   */
  private async sendMessage(
    params: SendMessageParams,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.apiClient) {
      return { success: false, error: 'API client not initialized' };
    }

    // Get first available protocol
    const protocol = this.connectedProtocols[0];
    if (!protocol) {
      return { success: false, error: 'No protocol available' };
    }

    try {
      const action = params.target.type === 'user' ? 'send_private_msg' : 'send_group_msg';
      const targetKey = params.target.type === 'user' ? 'user_id' : 'group_id';
      // Milky API expects numeric ids; target.id is string from MCP/JSON
      const targetId = Number(params.target.id);
      if (Number.isNaN(targetId)) {
        return { success: false, error: `Invalid target id: ${params.target.id}` };
      }

      const apiParams: Record<string, unknown> = {
        [targetKey]: targetId,
        message: params.content,
      };

      if (params.replyTo) {
        // Add reply segment if replying to a message
        apiParams.message = [
          { type: 'reply', data: { id: params.replyTo } },
          { type: 'text', data: { text: params.content } },
        ];
      }

      const result = await this.apiClient.call<SendMessageResult>(action, apiParams, protocol);
      const messageId = result?.message_id ?? result?.message_seq;
      return {
        success: true,
        messageId: messageId?.toString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[ClaudeCodeService] Send message error:', error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle task updates - send results back to requester
   */
  private async handleTaskUpdate(task: ClaudeTask): Promise<void> {
    // Only send updates for completed or failed tasks
    if (task.status !== 'completed' && task.status !== 'failed') {
      return;
    }

    const { requestedBy } = task;
    let content: string;

    if (task.status === 'completed') {
      content = `Claude Code 任务完成 (${task.id.slice(0, 8)}):\n${task.result || '无结果'}`;
    } else {
      content = `Claude Code 任务失败 (${task.id.slice(0, 8)}):\n${task.error || '未知错误'}`;
    }

    // Truncate long messages
    const maxLength = 2000;
    if (content.length > maxLength) {
      content = `${content.slice(0, maxLength - 20)}\n...(内容已截断)`;
    }

    await this.sendMessage({
      target: {
        type: requestedBy.type,
        id: requestedBy.id,
      },
      content,
      replyTo: requestedBy.messageId,
    });
  }

  /**
   * Execute a bot command
   */
  private async executeCommand(params: ExecuteCommandParams): Promise<ExecuteCommandResult> {
    const { command, args = [] } = params;
    logger.info(`[ClaudeCodeService] Executing command: ${command} ${args.join(' ')}`);

    switch (command) {
      case 'restart':
        return await this.handleRestartCommand();

      case 'reload-plugins':
        return await this.handleReloadPluginsCommand();

      case 'status':
        return this.handleStatusCommand();

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  }

  /**
   * Handle restart command - pull code, update dependencies, restart bot
   */
  private async handleRestartCommand(): Promise<ExecuteCommandResult> {
    const workDir = this.config.workingDirectory || process.cwd();

    try {
      // Step 1: Git pull
      logger.info('[ClaudeCodeService] Pulling latest code...');
      const gitPull = spawn({
        cmd: ['git', 'pull'],
        cwd: workDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const gitExitCode = await gitPull.exited;
      if (gitExitCode !== 0) {
        const stderr = await new Response(gitPull.stderr).text();
        return { success: false, error: `Git pull failed: ${stderr}` };
      }
      const gitOutput = await new Response(gitPull.stdout).text();
      logger.info(`[ClaudeCodeService] Git pull output: ${gitOutput.trim()}`);

      // Step 2: Install dependencies
      logger.info('[ClaudeCodeService] Installing dependencies...');
      const bunInstall = spawn({
        cmd: ['bun', 'install'],
        cwd: workDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const bunExitCode = await bunInstall.exited;
      if (bunExitCode !== 0) {
        const stderr = await new Response(bunInstall.stderr).text();
        return { success: false, error: `Bun install failed: ${stderr}` };
      }
      logger.info('[ClaudeCodeService] Dependencies installed');

      // Step 3: Schedule restart
      logger.info('[ClaudeCodeService] Scheduling restart...');

      // Send message before restart
      const restartMessage = '🔄 Bot 正在重启，请稍候...';
      // We can't easily send to all users, so just log
      logger.info(`[ClaudeCodeService] ${restartMessage}`);

      // Schedule restart after a short delay to allow response to be sent
      setTimeout(() => {
        logger.info('[ClaudeCodeService] Restarting bot...');
        process.exit(0); // Exit with code 0, supervisor should restart
      }, 1000);

      return {
        success: true,
        message: 'Bot will restart in 1 second. Code pulled and dependencies updated.',
        data: { gitOutput: gitOutput.trim() },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[ClaudeCodeService] Restart command failed:', error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle reload-plugins command
   */
  private async handleReloadPluginsCommand(): Promise<ExecuteCommandResult> {
    // TODO: Implement plugin reload
    // This would require access to PluginManager
    return {
      success: false,
      error: 'Plugin reload not implemented yet',
    };
  }

  /**
   * Handle status command
   */
  private handleStatusCommand(): ExecuteCommandResult {
    return {
      success: true,
      message: 'Bot is running',
      data: {
        uptime: Date.now() - this.botStartTime,
        protocols: this.connectedProtocols,
        selfId: this.selfId,
        pendingTasks: this.taskManager.getPendingTaskCount(),
        runningTasks: this.taskManager.getRunningTaskCount(),
      },
    };
  }

  /**
   * Get MCP server URL
   */
  getServerUrl(): string {
    return this.mcpServer.getUrl();
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      serverUrl: this.getServerUrl(),
      pendingTasks: this.taskManager.getPendingTaskCount(),
      runningTasks: this.taskManager.getRunningTaskCount(),
    };
  }
}
