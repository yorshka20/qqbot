// GroupReportCommand - trigger group daily report manually
//
// Usage:
//   /report           生成今日群聊每日汇报

import { inject, injectable } from 'tsyringe';
import { getRolePreset } from '@/agent/SubAgentRolePresets';
import type { AIService } from '@/ai/AIService';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

@Command({
  name: 'group_report',
  description: '生成群聊每日汇报',
  usage: '/group_report',
  permissions: ['admin', 'owner'],
  aliases: ['群报告', '每日汇报'],
})
@injectable()
export class GroupReportCommand implements CommandHandler {
  name = 'group_report';
  description = '生成群聊每日汇报';
  usage = '/group_report';

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.PROMPT_MANAGER) private promptManager: PromptManager,
  ) {}

  async execute(_args: string[], context: CommandContext): Promise<CommandResult> {
    if (!context.groupId) {
      return { success: false, error: '此命令仅在群聊中可用' };
    }

    const preset = getRolePreset('group_report');
    const taskTemplate = this.promptManager.getTemplate('subagent.group_report.task');
    const description = taskTemplate
      ? this.promptManager.render('subagent.group_report.task', { message: '生成今日群聊每日汇报' })
      : '生成今日群聊每日汇报';

    const parentContext = {
      userId: context.userId,
      groupId: context.groupId,
      messageType: 'group' as const,
      protocol: context.metadata?.protocol as string | undefined,
    };

    const configOverrides = {
      ...preset.configOverrides,
      allowedTools: preset.defaultAllowedTools,
    };

    // Fire-and-forget: run subagent in background
    void (async () => {
      try {
        logger.info(`[GroupReportCommand] Starting report generation for group ${context.groupId}`);
        await this.aiService.runSubAgent(
          preset.type,
          { description, input: { instruction: description }, parentContext },
          configOverrides,
        );
        logger.info(`[GroupReportCommand] Report generation completed for group ${context.groupId}`);
      } catch (err) {
        logger.error(`[GroupReportCommand] Report generation failed:`, err);
      }
    })();

    const mb = new MessageBuilder();
    mb.text('⏳ 正在生成今日群聊汇报，请稍候...');
    return { success: true, segments: mb.build() };
  }
}
