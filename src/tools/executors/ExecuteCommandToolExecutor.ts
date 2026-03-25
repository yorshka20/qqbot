// ExecuteCommandToolExecutor — allows LLM to proxy-execute bot commands on behalf of the user.
// Permission checking is delegated to CommandManager.execute(), which uses the original
// sender's userId so only users who already have the required permission can trigger a command.

import { inject, injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { CommandManager } from '@/command/CommandManager';
import type { PermissionLevel } from '@/command/types';
import { CommandContextBuilder } from '@/context/CommandContextBuilder';
import { DITokens } from '@/core/DITokens';
import type { HookManager } from '@/hooks/HookManager';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Commands that must never be executed by the AI, regardless of user permission. */
const BLOCKED_COMMANDS = new Set(['shell', 'restart']);

@Tool({
  name: 'execute_command',
  description:
    '代理执行一条 bot 命令（如 /provider、/schedule、/echo 等）。仅当发送者拥有该命令所需权限时才会执行成功。',
  executor: 'execute_command',
  visibility: ['reply'],
  parameters: {
    command: {
      type: 'string',
      required: true,
      description: '命令名称（不含前缀），如 "provider"、"schedule"、"echo"',
    },
    args: {
      type: 'string',
      required: false,
      description: '命令参数，以空格分隔的字符串，如 "switch llm anthropic"',
    },
  },
  examples: [
    '帮我把AI切换到anthropic',
    '帮我添加一个定时任务，每天下午四点播报天气',
    '把echo插件关掉',
    '帮我看看有哪些AI provider',
  ],
  triggerKeywords: ['切换', '设置', '配置', '添加日程', '定时', 'provider', 'schedule', 'echo'],
  whenToUse:
    '当管理员（admin/owner）要求 bot 执行某个需要权限的命令时调用。如果用户没有对应权限，命令会被拒绝。不可用于 shell 和 restart 命令。调用前请先确认用户意图，不要在用户未明确要求时主动执行命令。',
})
@injectable()
export class ExecuteCommandToolExecutor extends BaseToolExecutor {
  name = 'execute_command';

  constructor(
    @inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager,
    @inject(DITokens.HOOK_MANAGER) private hookManager: HookManager,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const commandName = (call.parameters?.command as string | undefined)?.trim().toLowerCase();
    if (!commandName) {
      return this.error('缺少命令名称', 'Missing required parameter: command');
    }

    // Block dangerous commands
    if (BLOCKED_COMMANDS.has(commandName)) {
      return this.error(
        `命令 "${commandName}" 不允许通过 AI 代理执行`,
        `Command "${commandName}" is blocked from AI proxy execution`,
      );
    }

    // Verify the command exists
    const registration = this.commandManager.getRegistration(commandName);
    if (!registration) {
      return this.error(`命令 "${commandName}" 不存在`, `Command "${commandName}" not found`);
    }

    // We need hookContext to build a proper CommandContext with the original sender's identity
    const hookContext = context.hookContext;
    if (!hookContext) {
      return this.error('缺少上下文信息，无法执行命令', 'Missing hookContext');
    }

    // Parse args string into array, stripping any accidental command prefix the LLM may include
    let argsStr = (call.parameters?.args as string | undefined)?.trim() ?? '';
    // LLM sometimes passes args like "/nai-plus 美女" instead of just "美女" — strip the leading command reference
    const escapedCmd = commandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadingCmdPattern = new RegExp(`^/?${escapedCmd}\\s*`, 'i');
    argsStr = argsStr.replace(leadingCmdPattern, '').trim();
    const args = argsStr ? argsStr.split(/\s+/) : [];

    // Build CommandContext from the hook context — preserves the original sender's userId,
    // so CommandManager.execute() will apply normal permission checks.
    const commandContext = CommandContextBuilder.fromHookContext(hookContext).build();

    // Build a ParsedCommand
    const parsedCommand = {
      name: commandName,
      args,
      raw: `/${commandName} ${argsStr}`.trim(),
      prefix: '/',
    };

    logger.info(
      `[ExecuteCommandToolExecutor] AI proxy-executing command: /${commandName} ${argsStr} (sender: ${context.userId})`,
    );

    const result = await this.commandManager.execute(parsedCommand, commandContext, this.hookManager, hookContext);

    if (!result.success) {
      return this.error(result.error ?? `命令 /${commandName} 执行失败`, result.error ?? 'Command execution failed');
    }

    // Separate media segments (image/record) that need direct sending from text segments
    const textParts: string[] = [];
    const mediaSegments: MessageSegment[] = [];
    if (result.segments) {
      for (const seg of result.segments) {
        if (seg.type === 'text') {
          textParts.push(seg.data.text);
        } else if (seg.type === 'image' || seg.type === 'record') {
          mediaSegments.push(seg);
        }
      }
    }

    // If the command produced media segments, send them directly to the chat
    // since the normal pipeline SEND stage won't handle segments from tool results.
    if (mediaSegments.length > 0) {
      try {
        await this.messageAPI.sendFromContext(mediaSegments, commandContext, 60000);
        logger.info(`[ExecuteCommandToolExecutor] Sent ${mediaSegments.length} media segment(s) for /${commandName}`);
        textParts.push(`[已发送${mediaSegments.length}个媒体文件]`);
      } catch (err) {
        logger.error(`[ExecuteCommandToolExecutor] Failed to send media for /${commandName}:`, err);
        textParts.push(`[媒体文件发送失败]`);
      }
    }

    const replyText = textParts.length > 0 ? textParts.join('\n') : `命令 /${commandName} 执行成功`;

    return this.success(replyText, {
      command: commandName,
      args,
    });
  }

  /**
   * Get a summary of admin-level commands available for proxy execution.
   * Used by system prompt generation to inform the LLM of available commands.
   */
  getAvailableAdminCommands(): {
    name: string;
    description?: string;
    usage?: string;
    permissions?: PermissionLevel[];
  }[] {
    const allCommands = this.commandManager.getAllCommands({
      userId: '0',
      groupId: '',
      userType: 'owner',
    });

    return allCommands
      .filter((reg) => {
        const perms = reg.permissions ?? reg.handler.permissions;
        if (!perms || perms.length === 0) return false;
        // Only include commands that require admin or owner permission
        const requiresElevated = perms.some((p) => p === 'admin' || p === 'owner');
        if (!requiresElevated) return false;
        // Exclude blocked commands
        if (BLOCKED_COMMANDS.has(reg.handler.name.toLowerCase())) return false;
        return true;
      })
      .map((reg) => ({
        name: reg.handler.name,
        description: reg.handler.description,
        usage: reg.handler.usage,
        permissions: reg.permissions ?? reg.handler.permissions,
      }));
  }
}
