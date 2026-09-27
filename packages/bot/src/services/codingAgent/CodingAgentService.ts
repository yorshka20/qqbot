/**
 * Coding Agent Service
 *
 * Integrates the MCP tool server and the task manager with the bot:
 * - Starting/stopping the MCP server
 * - Triggering coding tasks from bot commands, run by the claude or codex CLI
 * - Sending task results back to users
 */

import { spawn } from 'bun';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CodingAgentConfig, ProtocolName } from '@/core/config';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { CodingAgentMcpServer } from './CodingAgentMcpServer';
import { CodingAgentTaskManager } from './CodingAgentTaskManager';
import { type AgentExecutor, createAgentExecutors } from './executors';
import type { ProjectRegistry } from './ProjectRegistry';
import type {
  AgentExecutorName,
  AgentTask,
  AgentTaskType,
  ExecuteCommandParams,
  ExecuteCommandResult,
  ProjectContext,
  SendMessageParams,
} from './types';

export interface TriggerTaskOptions {
  /** Defaults to `codingAgent.defaultExecutor`. */
  executor?: AgentExecutorName;
  taskType?: AgentTaskType;
  projectContext?: ProjectContext;
  /** When true, the global handleTaskUpdate callback skips sending result messages */
  suppressDefaultNotification?: boolean;
}

export class CodingAgentService {
  private config: CodingAgentConfig;
  private mcpServer: CodingAgentMcpServer;
  private executors: Record<AgentExecutorName, AgentExecutor>;
  private defaultExecutor: AgentExecutorName;
  private taskManager: CodingAgentTaskManager;
  private messageAPI: MessageAPI | null = null;
  private botStartTime: number;
  private connectedProtocols: ProtocolName[] = [];
  private selfId: string | null = null;
  private projectRegistry: ProjectRegistry | null = null;

  constructor(config: CodingAgentConfig) {
    this.config = config;
    this.mcpServer = new CodingAgentMcpServer(config);
    this.executors = createAgentExecutors(config);
    this.defaultExecutor = config.defaultExecutor || 'claude';
    this.taskManager = new CodingAgentTaskManager(config, this.executors, this.mcpServer.getMcpUrl());
    this.botStartTime = Date.now();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle task notifications from the agent CLI
    this.mcpServer.setTaskNotificationHandler((notification) => {
      this.taskManager.handleTaskNotification(notification);
    });

    // Handle send message requests from the agent CLI
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

    // Handle command execution requests from the agent CLI
    this.mcpServer.setExecuteCommandHandler(async (params) => {
      return await this.executeCommand(params);
    });
  }

  /**
   * Set MessageAPI for sending messages
   */
  setMessageAPI(messageAPI: MessageAPI): void {
    this.messageAPI = messageAPI;
  }

  /**
   * Set PromptManager for template rendering
   */
  setPromptManager(promptManager: PromptManager): void {
    this.taskManager.setPromptManager(promptManager);
  }

  /**
   * Set ProjectRegistry for multi-project support
   */
  setProjectRegistry(registry: ProjectRegistry): void {
    this.projectRegistry = registry;
  }

  /**
   * Get ProjectRegistry
   */
  getProjectRegistry(): ProjectRegistry | null {
    return this.projectRegistry;
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
    logger.info(`[CodingAgentService] Service started. MCP endpoint: ${this.mcpServer.getMcpUrl()}`);
    return url;
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    await this.mcpServer.stop();
    logger.info('[CodingAgentService] Service stopped');
  }

  /**
   * Trigger a coding task.
   * Tasks for the same project are queued and executed serially, whichever
   * executor runs them. Tasks for different projects can run concurrently.
   */
  async triggerTask(
    prompt: string,
    requestedBy: AgentTask['requestedBy'],
    workingDirectory?: string,
    options?: TriggerTaskOptions,
  ): Promise<AgentTask & { queuePosition: number }> {
    const task = this.taskManager.createTask(prompt, requestedBy, workingDirectory, {
      ...options,
      executor: options?.executor || this.defaultExecutor,
    });

    // Enqueue task — starts immediately if no task is running for this project,
    // otherwise queues it for serial execution
    const { queuePosition } = this.taskManager.enqueueTask(task.id);

    return { ...task, queuePosition };
  }

  getExecutor(name: AgentExecutorName): AgentExecutor {
    return this.executors[name];
  }

  /**
   * Await a task's completion. Returns a promise that resolves when the task
   * transitions to 'completed' or 'failed' status.
   */
  awaitTaskCompletion(taskId: string): Promise<AgentTask> {
    return this.taskManager.awaitTaskCompletion(taskId);
  }

  /**
   * Get task status
   */
  getTask(taskId: string): AgentTask | undefined {
    return this.taskManager.getTask(taskId);
  }

  /**
   * Cancel a running task
   */
  cancelTask(taskId: string): boolean {
    return this.taskManager.cancelTask(taskId);
  }

  /**
   * Send message via MessageAPI
   */
  private async sendMessage(
    params: SendMessageParams & { forwardAs?: string },
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.messageAPI) {
      return { success: false, error: 'MessageAPI not initialized' };
    }

    // Get first available protocol
    const protocol = this.connectedProtocols[0];
    if (!protocol) {
      return { success: false, error: 'No protocol available' };
    }

    const targetId = Number(params.target.id);
    if (Number.isNaN(targetId)) {
      return { success: false, error: `Invalid target id: ${params.target.id}` };
    }

    try {
      const segments = new MessageBuilder().text(params.content).build();
      const botUserId = this.selfId ? Number(this.selfId) : 0;

      // Send as forward message to avoid flooding the chat with long text
      if (params.forwardAs && protocol === 'milky' && botUserId > 0) {
        const result = await this.messageAPI.sendForwardMessage(
          { type: params.target.type, id: targetId },
          [{ segments, senderName: params.forwardAs }],
          protocol,
          { botUserId },
        );
        const messageId = result?.message_id ?? result?.message_seq;
        return { success: true, messageId: messageId?.toString() };
      }

      // Regular message send
      const sendFn =
        params.target.type === 'user'
          ? this.messageAPI.sendPrivateMessage.bind(this.messageAPI, targetId)
          : this.messageAPI.sendGroupMessage.bind(this.messageAPI, targetId);

      const messageId = await sendFn(params.content, protocol);
      return { success: true, messageId: messageId?.toString() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[CodingAgentService] Send message error:', error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle task updates - send results back to requester
   */
  private async handleTaskUpdate(task: AgentTask): Promise<void> {
    // Only send updates for completed or failed tasks
    if (task.status !== 'completed' && task.status !== 'failed') {
      return;
    }

    // Skip default notification if the task was triggered with custom handling
    if (task.suppressDefaultNotification) {
      return;
    }

    const { requestedBy } = task;
    const agentName = this.executors[task.executor].displayName;
    let content: string;

    if (task.status === 'completed') {
      content = `${agentName} 任务完成 (${task.id.slice(0, 8)}):\n${task.result || '无结果'}`;
    } else {
      content = `${agentName} 任务失败 (${task.id.slice(0, 8)}):\n${task.error || '未知错误'}`;
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
      forwardAs: agentName,
    });
  }

  /**
   * Execute a bot command
   */
  private async executeCommand(params: ExecuteCommandParams): Promise<ExecuteCommandResult> {
    const { command, args = [] } = params;
    logger.info(`[CodingAgentService] Executing command: ${command} ${args.join(' ')}`);

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
      logger.info('[CodingAgentService] Pulling latest code...');
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
      logger.info(`[CodingAgentService] Git pull output: ${gitOutput.trim()}`);

      // Step 2: Install dependencies
      logger.info('[CodingAgentService] Installing dependencies...');
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
      logger.info('[CodingAgentService] Dependencies installed');

      // Step 3: Schedule restart
      logger.info('[CodingAgentService] Scheduling restart...');

      // Send message before restart
      const restartMessage = '🔄 Bot 正在重启，请稍候...';
      // We can't easily send to all users, so just log
      logger.info(`[CodingAgentService] ${restartMessage}`);

      // Schedule restart after a short delay to allow response to be sent
      setTimeout(() => {
        logger.info('[CodingAgentService] Restarting bot...');
        process.exit(0); // Exit with code 0, supervisor should restart
      }, 1000);

      return {
        success: true,
        message: 'Bot will restart in 1 second. Code pulled and dependencies updated.',
        data: { gitOutput: gitOutput.trim() },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[CodingAgentService] Restart command failed:', error);
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
   * Get the MCP endpoint URL (what a CLI's `--mcp-config` must point at).
   */
  getServerUrl(): string {
    return this.mcpServer.getMcpUrl();
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      serverUrl: this.getServerUrl(),
      defaultExecutor: this.defaultExecutor,
      pendingTasks: this.taskManager.getPendingTaskCount(),
      runningTasks: this.taskManager.getRunningTaskCount(),
      queueInfo: this.taskManager.getQueueInfo(),
    };
  }
}
