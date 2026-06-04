import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import { renderUsageCardImage } from '@/services/tokenUsage/renderUsageCard';
import type { TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

const TOP_N = 10;
const RECENT_DAYS = 3;

@Command({
  name: 'usage',
  description: '查看今日 Token 消耗 Top 10 及本人近三日消耗',
  usage: '/usage',
  permissions: ['user'],
  aliases: ['消耗', '用量'],
})
@injectable()
export class UsageCommandHandler implements CommandHandler {
  name = 'usage';
  description = '查看今日 Token 消耗 Top 10 及本人近三日消耗';
  usage = '/usage';

  constructor(@inject(DITokens.TOKEN_USAGE_SERVICE) private usageService: TokenUsageService) {}

  async execute(_args: string[], context: CommandContext): Promise<CommandResult> {
    const today = this.usageService.getLocalDate(0);
    const recentDates = Array.from({ length: RECENT_DAYS }, (_, i) => this.usageService.getLocalDate(i));
    const selfId = String(context.userId);

    const [report, mine] = await Promise.all([
      this.usageService.getDailyReport(today, TOP_N),
      this.usageService.getUserDailyBreakdown(selfId, recentDates),
    ]);

    const selfName = report.topUsers.find((u) => u.userId === selfId)?.nickname;

    try {
      const buffer = await renderUsageCardImage({ report, mine, selfId, selfName });
      return { success: true, segments: new MessageBuilder().image({ data: buffer.toString('base64') }).build() };
    } catch (err) {
      logger.warn('[UsageCommandHandler] Card render failed, falling back to text:', err);
      return { success: true, segments: new MessageBuilder().text(this.fallbackText(report, mine)).build() };
    }
  }

  private fallbackText(
    report: Awaited<ReturnType<TokenUsageService['getDailyReport']>>,
    mine: Awaited<ReturnType<TokenUsageService['getUserDailyBreakdown']>>,
  ): string {
    const fmt = (n: number) => n.toLocaleString('en-US');
    const lines = [
      `Token 消耗统计 · ${report.date}`,
      `今日 输入 ${fmt(report.promptTokens)} / 输出 ${fmt(report.completionTokens)} / 总计 ${fmt(report.totalTokens)}`,
      '',
      `今日 Top ${TOP_N}：`,
    ];
    if (report.topUsers.length === 0) {
      lines.push('  今日暂无消耗记录');
    } else {
      report.topUsers.forEach((u, i) => {
        const name = u.nickname ? `${u.nickname} (${u.userId})` : u.userId;
        lines.push(
          `  ${i + 1}. ${name} · 输入 ${fmt(u.promptTokens)} / 输出 ${fmt(u.completionTokens)} / 合计 ${fmt(u.totalTokens)}${u.totalImages > 0 ? ` · ${u.totalImages}图` : ''}`,
        );
      });
    }
    lines.push('', '我的近三日：');
    for (const d of mine) {
      lines.push(
        d.totalTokens === 0 && d.totalImages === 0
          ? `  ${d.date} · 无`
          : `  ${d.date} · 输入 ${fmt(d.promptTokens)} / 输出 ${fmt(d.completionTokens)} / 合计 ${fmt(d.totalTokens)}${d.totalImages > 0 ? ` · ${d.totalImages}图` : ''}`,
      );
    }
    return lines.join('\n');
  }
}
