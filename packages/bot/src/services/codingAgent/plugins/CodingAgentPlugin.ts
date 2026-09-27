/**
 * Coding Agent Plugin
 *
 * Registers one command per executor (`/claude`, `/codex`). The commands are
 * identical — same subcommands, prompt, project registry and task queue — and
 * differ only in which CLI runs the task they create.
 */

import { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { PluginCommandHandler } from '@/plugins/PluginCommandHandler';
import type { CodingAgentService } from '@/services/codingAgent/CodingAgentService';
import { type ParsedAgentCommand, parseAgentCommand } from '@/services/codingAgent/parseAgentCommand';
import { AgentRunOptionsError } from '@/services/codingAgent/runOptions';
import {
  AGENT_EXECUTOR_NAMES,
  type AgentExecutorName,
  type AgentRunOptions,
  type AgentTask,
  type ProjectContext,
} from '@/services/codingAgent/types';
import { logger } from '@/utils/logger';

function runOptionsUsage(cmd: AgentExecutorName): string {
  return `/${cmd} [--model <模型>] [--effort <强度>] [@<alias>] <prompt>
  参数写在最前面，也可写成 -m / -e 或 --model=<模型>；/${cmd} models 查看可用模型与强度`;
}

function usage(cmd: AgentExecutorName): string {
  return `/${cmd} <任务> - 在独立工作区执行（调研、做网页/脚本/文档等），结果和文件发回聊天
/${cmd} @<项目> <任务> - 在已注册项目里开发（改代码、提交）
/${cmd} --model <模型> --effort <强度> <prompt> - 指定模型与推理强度
/${cmd} models - 查看可用模型与强度
/${cmd} new <path> [--type bun|node|python|rust] <prompt> - 创建新项目
/${cmd} projects - 列出已注册项目
/${cmd} projects add <alias> <path> - 注册新项目
/${cmd} projects remove <alias> - 移除项目注册
/${cmd} status [taskId] - 查看任务状态
/${cmd} cancel <taskId> - 取消任务
/${cmd} info - 查看服务信息`;
}

function reply(success: boolean, text: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { success, segments: new MessageBuilder().text(text).build(), ...extra };
}

function describeRun(task: AgentTask): string {
  return task.effort ? `${task.model}, 强度 ${task.effort}` : `${task.model}, 默认强度`;
}

function runOptionsRejected(executor: AgentExecutorName, error: AgentRunOptionsError): CommandResult {
  return reply(false, `任务未执行：${error.message}\n\n用法：\n${runOptionsUsage(executor)}`, {
    error: error.message,
  });
}

@RegisterPlugin({
  name: 'codingAgent',
  version: '1.0.0',
  description: 'Coding agent integration - trigger and manage claude / codex development tasks',
})
export class CodingAgentPlugin extends PluginBase {
  private commandManager!: CommandManager;
  private agentService: CodingAgentService | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve(CommandManager);

    // container-lookup: optional-service CodingAgentService is only registered when codingAgent.enabled is true
    if (container.isRegistered(DITokens.CODING_AGENT_SERVICE)) {
      this.agentService = container.resolve<CodingAgentService>(DITokens.CODING_AGENT_SERVICE);
    } else {
      logger.warn('[CodingAgentPlugin] CodingAgentService not available - commands will report it as disabled');
    }
  }

  async onEnable(): Promise<void> {
    await super.onEnable();

    for (const executor of AGENT_EXECUTOR_NAMES) {
      const handler = new PluginCommandHandler(
        executor,
        `Coding agent (${executor}) - trigger and manage development tasks`,
        usage(executor),
        (args: string[], context: CommandContext) => this.executeCommand(executor, args, context),
        this.context,
        ['admin'],
      );
      this.commandManager.register(handler, this.name);
    }
    logger.info(`[CodingAgentPlugin] Enabled commands: ${AGENT_EXECUTOR_NAMES.map((n) => `/${n}`).join(', ')}`);
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    for (const executor of AGENT_EXECUTOR_NAMES) {
      this.commandManager.unregister(executor);
    }
    logger.info('[CodingAgentPlugin] Disabled');
  }

  private async executeCommand(
    executor: AgentExecutorName,
    args: string[],
    context: CommandContext,
  ): Promise<CommandResult> {
    const service = this.agentService;
    if (!service) {
      return reply(false, 'Coding agent 服务未启用', { error: 'Coding agent service not available' });
    }

    if (args.length === 0) {
      return reply(true, `使用方法:\n${usage(executor)}`);
    }

    const parsed = parseAgentCommand(args);

    switch (parsed.type) {
      case 'invalid':
        return reply(false, `参数错误：${parsed.error}\n\n用法：\n${runOptionsUsage(executor)}`, {
          error: parsed.error,
        });

      case 'models':
        return this.handleModels(service, executor);

      case 'status':
        return this.handleStatus(service, parsed.args || []);

      case 'cancel':
        return this.handleCancel(service, executor, parsed.args || []);

      case 'info':
        return this.handleInfo(service);

      case 'project-management':
        return this.handleProjectManagement(service, executor, parsed.args || []);

      case 'new-project':
        return this.handleNewProject(service, executor, parsed, context);

      case 'task':
        return this.handleTrigger(
          service,
          executor,
          parsed.prompt || '',
          parsed.options ?? {},
          context,
          parsed.projectIdentifier,
        );
    }
  }

  private requesterOf(context: CommandContext) {
    return {
      type: context.messageType === 'group' ? ('group' as const) : ('user' as const),
      id: context.messageType === 'group' ? String(context.groupId) : String(context.userId),
      userId: String(context.userId),
      messageId: context.originalMessage?.messageId != null ? String(context.originalMessage.messageId) : undefined,
    };
  }

  private async handleTrigger(
    service: CodingAgentService,
    executor: AgentExecutorName,
    prompt: string,
    options: AgentRunOptions,
    context: CommandContext,
    projectIdentifier?: string,
  ): Promise<CommandResult> {
    if (!prompt) {
      return reply(true, `使用方法:\n${usage(executor)}`);
    }

    // Only an explicit @project puts the agent inside a repository; anything
    // else runs in a throwaway workspace and delivers to the chat.
    let workingDirectory: string | undefined;
    let projectContext: ProjectContext | undefined;
    if (projectIdentifier) {
      const project = service.getProjectRegistry()?.resolve(projectIdentifier);
      if (!project) {
        return reply(false, `未找到项目: ${projectIdentifier}\n使用 /${executor} projects 查看已注册项目`, {
          error: 'Project not found',
        });
      }
      workingDirectory = project.path;
      projectContext = {
        alias: project.alias,
        type: project.type,
        description: project.description,
        hasClaudeMd: project.hasClaudeMd,
        promptTemplateKey: project.promptTemplateKey,
      };
    }

    const agentName = service.getExecutor(executor).displayName;
    try {
      const task = await service.triggerTask(prompt, this.requesterOf(context), workingDirectory, {
        executor,
        run: options,
        taskType: projectContext ? 'dev' : 'workspace',
        projectContext,
      });

      const projectInfo = projectContext ? ` (项目: ${projectContext.alias})` : ' (独立工作区)';
      const queueMsg =
        task.queuePosition > 0 ? `\n队列位置: 第${task.queuePosition}位（前方有任务在执行，将自动排队等待）` : '';
      return reply(
        true,
        `${agentName} 任务已创建${projectInfo}\n` +
          `任务ID: ${task.id.slice(0, 8)}\n` +
          `模型: ${describeRun(task)}\n` +
          `状态: ${task.queuePosition > 0 ? '排队中' : task.status}${queueMsg}\n` +
          `提示: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n\n` +
          `任务完成后会自动通知您结果。`,
        { sentAsForward: true },
      );
    } catch (error) {
      if (error instanceof AgentRunOptionsError) {
        return runOptionsRejected(executor, error);
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[CodingAgentPlugin] Failed to trigger task:', error);
      return reply(false, `创建任务失败: ${errorMsg}`, { error: errorMsg, sentAsForward: true });
    }
  }

  private handleProjectManagement(
    service: CodingAgentService,
    executor: AgentExecutorName,
    args: string[],
  ): CommandResult {
    const registry = service.getProjectRegistry();
    if (!registry) {
      return reply(false, '项目注册表未配置', { error: 'ProjectRegistry not configured' });
    }

    const subCmd = args[0]?.toLowerCase();

    if (!subCmd || subCmd === 'list') {
      const projects = registry.list();
      if (projects.length === 0) {
        return reply(true, '没有已注册的项目');
      }

      const defaultAlias = registry.getDefaultProject();
      const lines = projects.map((p) => {
        const tags: string[] = [];
        if (p.alias === defaultAlias) tags.push('默认');
        if (registry.isConfigProject(p.alias)) tags.push('配置');
        const tagStr = tags.length > 0 ? ` (${tags.join(', ')})` : '';
        const desc = p.description ? ` - ${p.description}` : '';
        return `  ${p.alias}${tagStr}: ${p.path} [${p.type}]${desc}`;
      });

      return reply(true, `已注册项目:\n${lines.join('\n')}`, { sentAsForward: true });
    }

    if (subCmd === 'add') {
      const alias = args[1];
      const path = args[2];
      if (!alias || !path) {
        return reply(false, `用法: /${executor} projects add <alias> <path>`, { error: 'Missing arguments' });
      }

      try {
        const project = registry.addProject({ alias, path });
        return reply(true, `项目已注册: ${project.alias} → ${project.path} [${project.type}]`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return reply(false, `注册失败: ${errorMsg}`, { error: errorMsg });
      }
    }

    if (subCmd === 'remove') {
      const alias = args[1];
      if (!alias) {
        return reply(false, `用法: /${executor} projects remove <alias>`, { error: 'Missing alias' });
      }

      const removed = registry.unregister(alias);
      return reply(removed, removed ? `项目 "${alias}" 已移除` : `未找到项目: ${alias}`);
    }

    return reply(false, `未知子命令: ${subCmd}\n用法: /${executor} projects [list|add|remove]`, {
      error: 'Unknown sub-command',
    });
  }

  private async handleNewProject(
    service: CodingAgentService,
    executor: AgentExecutorName,
    parsed: ParsedAgentCommand,
    context: CommandContext,
  ): Promise<CommandResult> {
    if (!parsed.projectPath || !parsed.prompt) {
      return reply(false, `用法: /${executor} new <path> [--type bun|node|python|rust] <prompt>`, {
        error: 'Missing arguments',
      });
    }

    let resolvedPath = parsed.projectPath;
    if (resolvedPath.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '/home';
      resolvedPath = `${home}/${resolvedPath.slice(2)}`;
    }

    // For new projects the path may not exist yet, but the parent must be in allowed paths
    const registry = service.getProjectRegistry();
    if (registry && !registry.resolve(resolvedPath) && registry.list().length > 0) {
      logger.warn(`[CodingAgentPlugin] New project path may not be in allowed base paths: ${resolvedPath}`);
    }

    const projectType = (parsed.projectType || 'generic') as ProjectContext['type'];

    try {
      const task = await service.triggerTask(parsed.prompt, this.requesterOf(context), resolvedPath, {
        executor,
        run: parsed.options ?? {},
        taskType: 'new-project',
        projectContext: {
          alias: resolvedPath.split('/').pop() || 'new-project',
          type: projectType,
          hasClaudeMd: false,
        },
      });

      return reply(
        true,
        `新项目创建任务已启动 (${service.getExecutor(executor).displayName})\n` +
          `任务ID: ${task.id.slice(0, 8)}\n` +
          `模型: ${describeRun(task)}\n` +
          `路径: ${resolvedPath}\n` +
          `类型: ${projectType}\n` +
          `任务完成后会自动通知您结果。`,
        { sentAsForward: true },
      );
    } catch (error) {
      if (error instanceof AgentRunOptionsError) {
        return runOptionsRejected(executor, error);
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[CodingAgentPlugin] Failed to create new project task:', error);
      return reply(false, `创建新项目任务失败: ${errorMsg}`, { error: errorMsg, sentAsForward: true });
    }
  }

  private handleStatus(service: CodingAgentService, args: string[]): CommandResult {
    const taskId = args[0];

    if (taskId) {
      const task = service.getTask(taskId);
      if (!task) {
        return reply(false, `未找到任务: ${taskId}`, { error: 'Task not found' });
      }

      let statusText = `任务 ${task.id.slice(0, 8)}\n`;
      statusText += `执行者: ${service.getExecutor(task.executor).displayName} (${describeRun(task)})\n`;
      statusText += `状态: ${task.status}\n`;
      statusText += `创建时间: ${task.createdAt.toLocaleString()}\n`;
      statusText += `提示: ${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? '...' : ''}`;

      if (task.result) {
        statusText += `\n结果: ${task.result.slice(0, 200)}${task.result.length > 200 ? '...' : ''}`;
      }
      if (task.error) {
        statusText += `\n错误: ${task.error}`;
      }

      return reply(true, statusText, { sentAsForward: true });
    }

    const status = service.getStatus();
    let statusText =
      `Coding agent 服务状态\n` +
      `启用: ${status.enabled ? '是' : '否'}\n` +
      `默认执行者: ${status.defaultExecutor}\n` +
      `服务地址: ${status.serverUrl}\n` +
      `运行中任务: ${status.runningTasks}\n` +
      `排队中任务: ${status.pendingTasks}`;

    if (status.queueInfo && status.queueInfo.length > 0) {
      statusText += '\n\n项目队列:';
      for (const info of status.queueInfo) {
        const projectName = info.project.split('/').pop() || info.project;
        const runningId = info.running ? info.running.slice(0, 8) : '无';
        statusText += `\n  ${projectName}: 运行中=${runningId}, 排队=${info.queued}`;
      }
    }

    return reply(true, statusText, { sentAsForward: true });
  }

  private handleCancel(service: CodingAgentService, executor: AgentExecutorName, args: string[]): CommandResult {
    const taskId = args[0];
    if (!taskId) {
      return reply(false, `请提供任务ID: /${executor} cancel <taskId>`, { error: 'Missing task ID' });
    }

    if (service.cancelTask(taskId)) {
      return reply(true, `任务 ${taskId.slice(0, 8)} 已取消`, { sentAsForward: true });
    }

    return reply(false, `无法取消任务 ${taskId.slice(0, 8)} (可能已完成或不存在)`, {
      error: 'Cannot cancel task',
      sentAsForward: true,
    });
  }

  private async handleModels(service: CodingAgentService, executor: AgentExecutorName): Promise<CommandResult> {
    const agent = service.getExecutor(executor);
    let models: Awaited<ReturnType<typeof agent.listModels>>;
    try {
      models = await agent.listModels();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return reply(false, `获取 ${agent.displayName} 模型列表失败：${errorMsg}`, { error: errorMsg });
    }
    const lines = models.map((m) => {
      const tag = m.id === agent.defaultModel ? '（默认）' : '';
      return `  ${m.id}${tag}: ${m.efforts.join(' / ')}`;
    });
    const defaultEffort = agent.defaultEffort ? agent.defaultEffort : 'CLI 默认';
    return reply(
      true,
      `${agent.displayName} 可用模型与强度（默认强度：${defaultEffort}）\n${lines.join('\n')}\n\n用法：\n${runOptionsUsage(executor)}`,
      { sentAsForward: true },
    );
  }

  private handleInfo(service: CodingAgentService): CommandResult {
    const status = service.getStatus();
    return reply(
      true,
      `Coding agent 服务信息\n\n` +
        `执行者: ${AGENT_EXECUTOR_NAMES.map((n) => `/${n} → ${service.getExecutor(n).displayName}`).join(', ')}\n` +
        `MCP 端点: ${status.serverUrl}\n` +
        `MCP 工具:\n` +
        `  bot_notify_task - 任务状态通知\n` +
        `  bot_send_message - 发送消息\n` +
        `  bot_info - 获取 Bot 信息\n` +
        `  bot_command - 维护命令（restart/reload-plugins/status）\n\n` +
        `当前状态:\n` +
        `  待处理任务: ${status.pendingTasks}\n` +
        `  运行中任务: ${status.runningTasks}`,
      { sentAsForward: true },
    );
  }
}
