/**
 * Coding Agent Service
 *
 * Integrates the MCP tool server and the task manager with the bot:
 * - Starting/stopping the MCP server
 * - Triggering coding tasks from bot commands, run by the claude or codex CLI
 * - Sending task results back to users
 */

import { isAbsolute, join } from 'node:path';
import { spawn } from 'bun';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { CodingAgentConfig, ProtocolName } from '@/core/config';
import { parseCardDeck } from '@/services/card/cardTypes';
import { logger } from '@/utils/logger';
import { AgentDelivery, type AgentDeliveryDeps, type DeliveryResult } from './AgentDelivery';
import type { AgentToolBridge } from './AgentToolBridge';
import { CodingAgentMcpServer } from './CodingAgentMcpServer';
import { CodingAgentTaskManager, type TaskProgressUpdate } from './CodingAgentTaskManager';
import { type AgentExecutor, createAgentExecutors } from './executors';
import type { ProjectRegistry } from './ProjectRegistry';
import { resolveRunOptions } from './runOptions';
import type {
  AgentExecutorName,
  AgentRunOptions,
  AgentTask,
  AgentTaskType,
  ExecuteCommandParams,
  ExecuteCommandResult,
  ProjectContext,
} from './types';

const DEFAULT_MAX_FILE_MB = 30;

export interface TriggerTaskOptions {
  /** Defaults to `codingAgent.defaultExecutor`. */
  executor?: AgentExecutorName;
  /** Model / effort overrides; invalid values reject the task with `AgentRunOptionsError`. */
  run?: AgentRunOptions;
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
  private delivery: AgentDelivery | null = null;
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

    // The agent's own messages, cards and files, always to the task's requester
    this.mcpServer.setSendMessageHandler((taskId, content) =>
      this.withTask(taskId, (task, delivery) => delivery.sendText(task.requestedBy, content)),
    );
    this.mcpServer.setSendCardHandler((taskId, cards) =>
      this.withTask(taskId, (task, delivery) => this.sendCards(task, delivery, cards)),
    );
    this.mcpServer.setSendFileHandler((taskId, path, fileName) =>
      this.withTask(taskId, (task, delivery) => this.sendFile(task, delivery, path, fileName)),
    );

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

    // Relay the agent's started / progress reports to the requester
    this.taskManager.setTaskProgressCallback((task, update) => {
      this.handleTaskProgress(task, update);
    });

    // Any MCP request from a task's CLI keeps its idle watchdog fed
    this.mcpServer.setTaskActivityHandler((taskId) => {
      this.taskManager.touch(taskId);
    });

    // Handle command execution requests from the agent CLI.
    // Research tasks come from chat, where their instructions can be steered by
    // anyone who can talk to the bot or by the pages they read, so they cannot
    // restart or reconfigure the bot.
    this.mcpServer.setExecuteCommandHandler(async (taskId, params) => {
      const task = this.taskManager.getTask(taskId);
      if (!task || task.taskType === 'research') {
        return { success: false, error: 'bot_command is not available to this task' };
      }
      return await this.executeCommand(params);
    });
  }

  /**
   * Offer the bot's `agent`-scoped tools to running tasks, called with the task's requester as context.
   */
  attachBotTools(bridge: AgentToolBridge): void {
    this.mcpServer.setBotToolProvider({
      list: () => bridge.listTools(),
      call: async (taskId, name, parameters) => {
        const task = this.taskManager.getTask(taskId);
        const protocol = this.connectedProtocols[0];
        if (!task || !protocol) {
          return { success: false, reply: !task ? `Unknown task ${taskId}` : 'Bot is not connected yet' };
        }
        return bridge.call(task, protocol, name, parameters);
      },
    });
  }

  /**
   * Attach what the service needs to deliver to chats; available once the bot is connected.
   */
  attachDelivery(deps: AgentDeliveryDeps): void {
    this.delivery = new AgentDelivery(deps, () => ({
      protocol: this.connectedProtocols[0],
      selfId: this.selfId ? Number(this.selfId) : 0,
    }));
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
    const executor = options?.executor || this.defaultExecutor;
    const { model, effort } = await resolveRunOptions(this.executors[executor], options?.run ?? {});
    const task = this.taskManager.createTask(prompt, requestedBy, workingDirectory, {
      executor,
      model,
      effort,
      taskType: options?.taskType,
      projectContext: options?.projectContext,
      suppressDefaultNotification: options?.suppressDefaultNotification,
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

  private async withTask(
    taskId: string,
    send: (task: AgentTask, delivery: AgentDelivery) => Promise<DeliveryResult>,
  ): Promise<DeliveryResult> {
    const task = this.taskManager.getTask(taskId);
    if (!task) {
      return { success: false, error: `Unknown task ${taskId}` };
    }
    if (!this.delivery) {
      return { success: false, error: 'Bot is not connected yet' };
    }
    return send(task, this.delivery);
  }

  private async sendCards(task: AgentTask, delivery: AgentDelivery, cards: unknown[]): Promise<DeliveryResult> {
    let deck: ReturnType<typeof parseCardDeck>;
    try {
      deck = parseCardDeck(JSON.stringify(cards));
    } catch (error) {
      return {
        success: false,
        error: `卡片 schema 校验失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return delivery.sendCards(task.requestedBy, deck, {
      agentName: this.executors[task.executor].displayName,
      model: task.model,
    });
  }

  /**
   * Files may only leave the machine from a research task's own workspace: a
   * dev task's working directory is a repository, which can hold secrets.
   */
  private async sendFile(
    task: AgentTask,
    delivery: AgentDelivery,
    path: string,
    fileName: string | undefined,
  ): Promise<DeliveryResult> {
    if (task.taskType !== 'research' || !task.workingDirectory) {
      return { success: false, error: '只有调研任务可以发送文件' };
    }
    return delivery.sendFile(task.requestedBy, isAbsolute(path) ? path : join(task.workingDirectory, path), {
      root: task.workingDirectory,
      maxBytes: (this.config.maxFileMB ?? DEFAULT_MAX_FILE_MB) * 1024 * 1024,
      fileName,
    });
  }

  /**
   * Relay an agent's started / progress report to the requester as it happens
   */
  private async handleTaskProgress(task: AgentTask, update: TaskProgressUpdate): Promise<void> {
    if (task.suppressDefaultNotification) {
      return;
    }
    if (!this.delivery) {
      return;
    }
    const agentName = this.executors[task.executor].displayName;
    const label = update.status === 'started' ? '开始' : '进度';
    const percent = update.progress !== undefined ? ` [${update.progress}%]` : '';
    await this.delivery.sendText(
      task.requestedBy,
      `${agentName} ${label} (${task.id.slice(0, 8)})${percent}：${update.message}`,
    );
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

    if (!this.delivery) {
      logger.warn(`[CodingAgentService] Task ${task.id} finished before the bot connected; result not delivered`);
      return;
    }
    await this.delivery.sendText(requestedBy, content, agentName);
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
