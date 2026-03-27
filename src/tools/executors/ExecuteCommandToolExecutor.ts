// ExecuteCommandToolExecutor — allows LLM to proxy-execute bot commands on behalf of the user.
// Permission checking is delegated to CommandManager.execute(), which uses the original
// sender's userId so only users who already have the required permission can trigger a command.
//
// Implementation: clones the current hookContext with the parsed command set,
// then runs it through Lifecycle.executeProcessAndSend() so the command goes
// through the exact same CommandSystem → PREPARE → SEND pipeline as a normal
// user-typed command.

import { inject, injectable } from 'tsyringe';
import type { CommandManager } from '@/command/CommandManager';
import type { CommandResult } from '@/command/types';
import { HookContextBuilder } from '@/context/HookContextBuilder';
import type { Lifecycle } from '@/conversation/Lifecycle';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Commands that must never be executed by the AI, regardless of user permission. */
const BLOCKED_COMMANDS = new Set(['shell', 'restart']);

@Tool({
  name: 'execute_command',
  description:
    '代理执行一条 bot 命令（如 /provider、/schedule、/echo 等）。仅当发送者拥有该命令所需权限时才会执行成功。不确定有哪些命令时，先调用 list_bot_features 查看。',
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
    '当管理员（admin/owner）要求 bot 执行某个需要权限的命令时调用。如果用户没有对应权限，命令会被拒绝。不可用于 shell 和 restart 命令。调用前请先确认用户意图，不要在用户未明确要求时主动执行命令。不确定有哪些命令可用时，先调用 list_bot_features 查看可用命令列表。',
})
@injectable()
export class ExecuteCommandToolExecutor extends BaseToolExecutor {
  name = 'execute_command';

  constructor(
    @inject(DITokens.COMMAND_MANAGER) private commandManager: CommandManager,
    @inject(DITokens.LIFECYCLE) private lifecycle: Lifecycle,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const commandName = (call.parameters?.command as string | undefined)?.trim().toLowerCase();
    if (!commandName) {
      return this.error('缺少命令名称', 'Missing required parameter: command');
    }

    if (BLOCKED_COMMANDS.has(commandName)) {
      return this.error(
        `命令 "${commandName}" 不允许通过 AI 代理执行`,
        `Command "${commandName}" is blocked from AI proxy execution`,
      );
    }

    const registration = this.commandManager.getRegistration(commandName);
    if (!registration) {
      return this.error(`命令 "${commandName}" 不存在`, `Command "${commandName}" not found`);
    }

    const hookContext = context.hookContext;
    if (!hookContext) {
      return this.error('缺少上下文信息，无法执行命令', 'Missing hookContext');
    }

    // Parse args
    let argsStr = (call.parameters?.args as string | undefined)?.trim() ?? '';
    const escapedCmd = commandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    argsStr = argsStr.replace(new RegExp(`^/?${escapedCmd}\\s*`, 'i'), '').trim();
    const args = argsStr ? argsStr.split(/\s+/) : [];

    const parsedCommand = {
      name: commandName,
      args,
      raw: `/${commandName} ${argsStr}`.trim(),
      prefix: '/',
    };

    const cmdDisplay = `/${commandName}${argsStr ? ' ' + argsStr : ''}`;
    logger.info(`[ExecuteCommandToolExecutor] AI proxy-executing command: ${cmdDisplay} (sender: ${context.userId})`);

    // Clone hookContext with the command set, then run through normal pipeline.
    // CommandSystem → ReplyPrepareSystem → SendSystem — exact same path as a user-typed command.
    const cmdContext = HookContextBuilder.fromContext(hookContext).withCommand(parsedCommand).build();

    await this.lifecycle.executeProcessAndSend(cmdContext);

    // Read result from the pipeline-executed context
    const result = cmdContext.result as CommandResult | undefined;
    const success = result?.success ?? false;
    const resultText = success
      ? (result?.segments
          ?.filter((s) => s.type === 'text')
          .map((s) => s.data.text)
          .join('\n') ?? '执行成功')
      : (result?.error ?? '执行失败');

    if (!success) {
      return this.error(`执行 ${cmdDisplay} 失败: ${resultText}`, resultText);
    }

    return this.success(`[已执行命令: ${cmdDisplay}]\n${resultText}`, {
      command: commandName,
      args,
    });
  }
}
