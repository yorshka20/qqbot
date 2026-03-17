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
import { logger } from '@/utils/logger';

const USAGE = `/claude <prompt> - 触发 Claude Code 任务
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

    const subCommand = args[0].toLowerCase();

    switch (subCommand) {
      case 'status':
        return this.handleStatus(args.slice(1));

      case 'cancel':
        return this.handleCancel(args.slice(1));

      case 'info':
        return this.handleInfo();

      default:
        // Treat as prompt
        return this.handleTrigger(args.join(' '), context);
    }
  }

  private async handleTrigger(prompt: string, context: CommandContext): Promise<CommandResult> {
    if (!this.claudeCodeService) {
      return {
        success: false,
        segments: new MessageBuilder().text('Claude Code 服务未启用').build(),
        error: 'Service not available',
      };
    }

    const userId = String(context.userId);

    // Check if user is allowed
    if (!this.claudeCodeService.canUserTriggerTask(userId)) {
      return {
        success: false,
        segments: new MessageBuilder().text('您没有权限触发 Claude Code 任务').build(),
        error: 'Permission denied',
      };
    }

    try {
      const targetId = context.messageType === 'group' ? String(context.groupId) : String(context.userId);
      const messageId =
        context.originalMessage?.messageId != null ? String(context.originalMessage.messageId) : undefined;

      const task = await this.claudeCodeService.triggerTask(prompt, {
        type: context.messageType === 'group' ? 'group' : 'user',
        id: targetId,
        messageId: messageId,
      });

      return {
        success: true,
        segments: new MessageBuilder()
          .text(
            `Claude Code 任务已创建\n` +
              `任务ID: ${task.id.slice(0, 8)}\n` +
              `状态: ${task.status}\n` +
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
    return {
      success: true,
      segments: new MessageBuilder()
        .text(
          `Claude Code 服务状态\n` +
            `启用: ${status.enabled ? '是' : '否'}\n` +
            `服务地址: ${status.serverUrl}\n` +
            `待处理任务: ${status.pendingTasks}\n` +
            `运行中任务: ${status.runningTasks}`,
        )
        .build(),
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
