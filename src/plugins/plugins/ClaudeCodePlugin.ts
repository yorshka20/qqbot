/**
 * Claude Code Plugin
 *
 * Provides commands to trigger and manage Claude Code tasks from the bot.
 *
 * Commands:
 * - /claude <prompt> - Trigger a Claude Code task with the given prompt
 * - /claude status [taskId] - Get status of a task or all tasks
 * - /claude cancel <taskId> - Cancel a running task
 * - /claude info - Get Claude Code service info
 */

import type { CommandManager } from '@/command/CommandManager';
import type { CommandContext, CommandResult } from '@/command/types';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { PluginCommandHandler } from '@/plugins/PluginCommandHandler';
import type { ClaudeCodeService } from '@/services/claudeCode/ClaudeCodeService';
import { parseClaudeCommand } from '@/services/claudeCode/parseClaudeCommand';
import { logger } from '@/utils/logger';

const USAGE = `/claude <prompt> - 触发 Claude Code 任务（默认项目）
/claude @<alias> <prompt> - 在指定项目中执行任务
/claude new <path> [--type bun|node|python|rust] <prompt> - 创建新项目
/claude projects - 列出已注册项目
/claude projects add <alias> <path> - 注册新项目
/claude projects remove <alias> - 移除项目注册
/claude status [taskId] - 查看任务状态
/claude cancel <taskId> - 取消任务
/claude info - 查看服务信息`;

/**
 * Claude Code Plugin
 * Provides commands to interact with Claude Code via the bot
 */
@RegisterPlugin({
  name: 'claudeCode',
  version: '1.0.0',
  description: 'Claude Code integration - trigger and manage Claude Code tasks',
})
export class ClaudeCodePlugin extends PluginBase {
  private commandManager!: CommandManager;
  private claudeCodeService: ClaudeCodeService | null = null;

  async onInit(): Promise<void> {
    const container = getContainer();
    this.commandManager = container.resolve<CommandManager>(DITokens.COMMAND_MANAGER);

    if (!this.commandManager) {
      throw new Error('[ClaudeCodePlugin] CommandManager not found');
    }

    // Try to get Claude Code service (may not be available if not configured)
    try {
      this.claudeCodeService = container.resolve<ClaudeCodeService>(DITokens.CLAUDE_CODE_SERVICE);
    } catch {
      logger.warn('[ClaudeCodePlugin] ClaudeCodeService not available - plugin will be disabled');
    }
  }

  async onEnable(): Promise<void> {
    await super.onEnable();

    if (!this.claudeCodeService) {
      logger.warn('[ClaudeCodePlugin] ClaudeCodeService not available - commands will not work');
    }

    const handler = new PluginCommandHandler(
      'claude',
      'Claude Code integration - trigger and manage Claude Code tasks',
      USAGE,
      async (args: string[], context: CommandContext) => {
        return await this.executeClaudeCommand(args, context);
      },
      this.context,
      ['admin'], // Only admins can use this command
    );

    this.commandManager.register(handler, this.name);
    logger.info('[ClaudeCodePlugin] Claude Code plugin enabled');
  }

  async onDisable(): Promise<void> {
    await super.onDisable();
    this.commandManager.unregister('claude');
    logger.info('[ClaudeCodePlugin] Claude Code plugin disabled');
  }

  private async executeClaudeCommand(args: string[], context: CommandContext): Promise<CommandResult> {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Claude Code service not available',
      };
    }

    if (args.length === 0) {
      return {
        success: true,
        segments: new MessageBuilder().text(`使用方法:\n${USAGE}`).build(),
      };
    }

    const parsed = parseClaudeCommand(args);

    switch (parsed.type) {
      case 'status':
        return this.handleStatus(parsed.args || []);

      case 'cancel':
        return this.handleCancel(parsed.args || []);

      case 'info':
        return this.handleInfo();

      case 'project-management':
        return this.handleProjectManagement(parsed.args || []);

      case 'new-project':
        return this.handleNewProject(parsed, context);

      case 'task':
        return this.handleTrigger(parsed.prompt || '', context, parsed.projectIdentifier);
    }
  }

  private async handleTrigger(
    prompt: string,
    context: CommandContext,
    projectIdentifier?: string,
  ): Promise<CommandResult> {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    if (!prompt) {
      return {
        success: true,
        segments: new MessageBuilder().text(`使用方法:\n${USAGE}`).build(),
      };
    }

    // Resolve project context
    const registry = this.claudeCodeService.getProjectRegistry();
    let workingDirectory: string | undefined;
    let projectContext: import('@/services/mcpServer/types').ProjectContext | undefined;

    if (registry) {
      const project = registry.resolve(projectIdentifier);
      if (projectIdentifier && !project) {
        return {
          success: false,
          segments: new MessageBuilder()
            .text(`未找到项目: ${projectIdentifier}\n使用 /claude projects 查看已注册项目`)
            .build(),
          error: 'Project not found',
        };
      }
      if (project) {
        workingDirectory = project.path;
        projectContext = {
          alias: project.alias,
          type: project.type,
          description: project.description,
          hasClaudeMd: project.hasClaudeMd,
          promptTemplateKey: project.promptTemplateKey,
        };
      }
    }

    try {
      const targetId = context.messageType === 'group' ? String(context.groupId) : String(context.userId);
      const messageId =
        context.originalMessage?.messageId != null ? String(context.originalMessage.messageId) : undefined;

      const task = await this.claudeCodeService.triggerTask(
        prompt,
        {
          type: context.messageType === 'group' ? 'group' : 'user',
          id: targetId,
          messageId,
        },
        workingDirectory,
        { taskType: 'dev', projectContext },
      );

      const projectInfo = projectContext ? ` (项目: ${projectContext.alias})` : '';
      const queueMsg =
        task.queuePosition > 0 ? `\n队列位置: 第${task.queuePosition}位（前方有任务在执行，将自动排队等待）` : '';
      return {
        success: true,
        segments: new MessageBuilder()
          .text(
            `Claude Code 任务已创建${projectInfo}\n` +
              `任务ID: ${task.id.slice(0, 8)}\n` +
              `状态: ${task.queuePosition > 0 ? '排队中' : task.status}${queueMsg}\n` +
              `提示: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n\n` +
              `任务完成后会自动通知您结果。`,
          )
          .build(),
        sentAsForward: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[ClaudeCodePlugin] Failed to trigger task:', error);
      return {
        success: false,
        segments: new MessageBuilder().text(`创建任务失败: ${errorMsg}`).build(),
        error: errorMsg,
        sentAsForward: true,
      };
    }
  }

  private handleProjectManagement(args: string[]): CommandResult {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    const registry = this.claudeCodeService.getProjectRegistry();
    if (!registry) {
      return {
        success: false,
        segments: new MessageBuilder().text('项目注册表未配置').build(),
        error: 'ProjectRegistry not configured',
      };
    }

    const subCmd = args[0]?.toLowerCase();

    if (!subCmd || subCmd === 'list') {
      // List all projects
      const projects = registry.list();
      if (projects.length === 0) {
        return {
          success: true,
          segments: new MessageBuilder().text('没有已注册的项目').build(),
        };
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

      return {
        success: true,
        segments: new MessageBuilder().text(`已注册项目:\n${lines.join('\n')}`).build(),
        sentAsForward: true,
      };
    }

    if (subCmd === 'add') {
      const alias = args[1];
      const path = args[2];
      if (!alias || !path) {
        return {
          success: false,
          segments: new MessageBuilder().text('用法: /claude projects add <alias> <path>').build(),
          error: 'Missing arguments',
        };
      }

      try {
        const project = registry.addProject({ alias, path });
        return {
          success: true,
          segments: new MessageBuilder()
            .text(`项目已注册: ${project.alias} → ${project.path} [${project.type}]`)
            .build(),
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          segments: new MessageBuilder().text(`注册失败: ${errorMsg}`).build(),
          error: errorMsg,
        };
      }
    }

    if (subCmd === 'remove') {
      const alias = args[1];
      if (!alias) {
        return {
          success: false,
          segments: new MessageBuilder().text('用法: /claude projects remove <alias>').build(),
          error: 'Missing alias',
        };
      }

      const removed = registry.unregister(alias);
      return {
        success: removed,
        segments: new MessageBuilder().text(removed ? `项目 "${alias}" 已移除` : `未找到项目: ${alias}`).build(),
      };
    }

    return {
      success: false,
      segments: new MessageBuilder().text(`未知子命令: ${subCmd}\n用法: /claude projects [list|add|remove]`).build(),
      error: 'Unknown sub-command',
    };
  }

  private async handleNewProject(
    parsed: import('@/services/claudeCode/parseClaudeCommand').ParsedClaudeCommand,
    context: CommandContext,
  ): Promise<CommandResult> {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    if (!parsed.projectPath || !parsed.prompt) {
      return {
        success: false,
        segments: new MessageBuilder().text('用法: /claude new <path> [--type bun|node|python|rust] <prompt>').build(),
        error: 'Missing arguments',
      };
    }

    // Resolve the project path
    const registry = this.claudeCodeService.getProjectRegistry();
    let resolvedPath = parsed.projectPath;
    if (resolvedPath.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '/home';
      resolvedPath = `${home}/${resolvedPath.slice(2)}`;
    }

    // Validate path if registry exists
    if (registry) {
      const testResolve = registry.resolve(resolvedPath);
      // For new projects the path may not exist yet, but the parent must be in allowed paths
      if (!testResolve && registry.list().length > 0) {
        // Check if path is at least under an allowed base by trying to resolve parent
        logger.warn(`[ClaudeCodePlugin] New project path may not be in allowed base paths: ${resolvedPath}`);
      }
    }

    const projectType = (parsed.projectType || 'generic') as 'bun' | 'node' | 'python' | 'rust' | 'generic';

    try {
      const targetId = context.messageType === 'group' ? String(context.groupId) : String(context.userId);
      const messageId =
        context.originalMessage?.messageId != null ? String(context.originalMessage.messageId) : undefined;

      const task = await this.claudeCodeService.triggerTask(
        parsed.prompt,
        {
          type: context.messageType === 'group' ? 'group' : 'user',
          id: targetId,
          messageId,
        },
        resolvedPath,
        {
          taskType: 'new-project',
          projectContext: {
            alias: resolvedPath.split('/').pop() || 'new-project',
            type: projectType,
            hasClaudeMd: false,
          },
        },
      );

      return {
        success: true,
        segments: new MessageBuilder()
          .text(
            `新项目创建任务已启动\n` +
              `任务ID: ${task.id.slice(0, 8)}\n` +
              `路径: ${resolvedPath}\n` +
              `类型: ${projectType}\n` +
              `任务完成后会自动通知您结果。`,
          )
          .build(),
        sentAsForward: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('[ClaudeCodePlugin] Failed to create new project task:', error);
      return {
        success: false,
        segments: new MessageBuilder().text(`创建新项目任务失败: ${errorMsg}`).build(),
        error: errorMsg,
        sentAsForward: true,
      };
    }
  }

  private handleStatus(args: string[]): CommandResult {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    const taskId = args[0];

    if (taskId) {
      // Get specific task status
      const task = this.claudeCodeService.getTask(taskId);
      if (!task) {
        return {
          success: false,
          segments: new MessageBuilder().text(`未找到任务: ${taskId}`).build(),
          error: 'Task not found',
        };
      }

      let statusText = `任务 ${task.id.slice(0, 8)}\n`;
      statusText += `状态: ${task.status}\n`;
      statusText += `创建时间: ${task.createdAt.toLocaleString()}\n`;
      statusText += `提示: ${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? '...' : ''}`;

      if (task.result) {
        statusText += `\n结果: ${task.result.slice(0, 200)}${task.result.length > 200 ? '...' : ''}`;
      }
      if (task.error) {
        statusText += `\n错误: ${task.error}`;
      }

      return {
        success: true,
        segments: new MessageBuilder().text(statusText).build(),
        sentAsForward: true,
      };
    }

    // Get service status
    const status = this.claudeCodeService.getStatus();
    let statusText =
      `Claude Code 服务状态\n` +
      `启用: ${status.enabled ? '是' : '否'}\n` +
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

    return {
      success: true,
      segments: new MessageBuilder().text(statusText).build(),
      sentAsForward: true,
    };
  }

  private handleCancel(args: string[]): CommandResult {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    const taskId = args[0];
    if (!taskId) {
      return {
        success: false,
        segments: new MessageBuilder().text('请提供任务ID: /claude cancel <taskId>').build(),
        error: 'Missing task ID',
      };
    }

    const cancelled = this.claudeCodeService.cancelTask(taskId);
    if (cancelled) {
      return {
        success: true,
        segments: new MessageBuilder().text(`任务 ${taskId.slice(0, 8)} 已取消`).build(),
        sentAsForward: true,
      };
    }

    return {
      success: false,
      segments: new MessageBuilder().text(`无法取消任务 ${taskId.slice(0, 8)} (可能已完成或不存在)`).build(),
      error: 'Cannot cancel task',
      sentAsForward: true,
    };
  }

  private handleInfo(): CommandResult {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    const status = this.claudeCodeService.getStatus();
    return {
      success: true,
      segments: new MessageBuilder()
        .text(
          `Claude Code 服务信息\n\n` +
            `服务地址: ${status.serverUrl}\n` +
            `API 端点:\n` +
            `  POST /api/notify - 任务状态通知\n` +
            `  POST /api/send - 发送消息\n` +
            `  GET /api/info - 获取 Bot 信息\n\n` +
            `当前状态:\n` +
            `  待处理任务: ${status.pendingTasks}\n` +
            `  运行中任务: ${status.runningTasks}`,
        )
        .build(),
      sentAsForward: true,
    };
  }
}
