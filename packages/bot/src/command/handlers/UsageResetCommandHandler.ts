import { inject, injectable } from 'tsyringe';
import { MessageBuilder } from '@/message/MessageBuilder';
import { UsageBudgetService } from '@/services/tokenUsage/UsageBudgetService';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

@Command({
  name: 'usage_reset',
  description: '重置某人今日 AI 额度（消耗统计保留）（管理员）',
  usage: '/usage_reset <QQ号>　或　/usage_reset @某人',
  permissions: ['admin'],
  aliases: ['重置额度'],
})
@injectable()
export class UsageResetCommandHandler implements CommandHandler {
  name = 'usage_reset';
  description = '重置某人今日 AI 额度（消耗统计保留）（管理员）';
  usage = '/usage_reset <QQ号>　或　/usage_reset @某人';

  constructor(@inject(UsageBudgetService) private budgetService: UsageBudgetService) {}

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const targetId = resolveTarget(args, context);
    if (!targetId) {
      return { success: false, error: `请指定要重置的用户：${this.usage}` };
    }

    const reset = await this.budgetService.resetUser(targetId);
    logger.info(
      `[UsageResetCommandHandler] Budget reset | target=${targetId} by=${context.userId} rows=${reset.waivedRows} waived=$${reset.waivedUsd.toFixed(4)}`,
    );

    const cap = reset.limitUsd == null ? '未配置上限' : `上限 $${reset.limitUsd.toFixed(2)}/天`;
    const text =
      reset.waivedRows === 0
        ? `${targetId} 今日（${reset.date}）本就没有消耗记录，额度是满的（${cap}）。`
        : `已重置 ${targetId} 今日（${reset.date}）额度：$${reset.waivedUsd.toFixed(4)} 不再计入限额，${cap}。` +
          `消耗统计保留，/usage 仍能看到这 ${reset.waivedRows} 条记录。`;
    return { success: true, segments: new MessageBuilder().text(text).build() };
  }
}

/**
 * An explicit id wins; otherwise the message's single @ target is taken. Two @s are
 * ambiguous (one of them is usually the bot), so those ask for the id instead.
 */
function resolveTarget(args: string[], context: CommandContext): string | null {
  const explicit = args[0]?.trim();
  if (explicit) {
    return /^\d+$/.test(explicit) ? explicit : null;
  }
  const mentioned = (context.originalMessage?.segments ?? [])
    .filter((segment) => segment.type === 'at')
    .map((segment) => String(segment.data?.qq ?? ''))
    .filter((qq) => /^\d+$/.test(qq));
  return mentioned.length === 1 ? mentioned[0] : null;
}
