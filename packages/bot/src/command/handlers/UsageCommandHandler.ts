import { inject, injectable } from 'tsyringe';
import type { AIService } from '@/ai';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { InfoCardData } from '@/services/card';
import type {
  DailyUsageAgg,
  ProviderUsageAgg,
  TokenUsageService,
  UserUsageAgg,
} from '@/services/tokenUsage/TokenUsageService';
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

  constructor(
    @inject(DITokens.TOKEN_USAGE_SERVICE) private usageService: TokenUsageService,
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
  ) {}

  async execute(_args: string[], context: CommandContext): Promise<CommandResult> {
    const today = this.usageService.getLocalDate(0);
    const recentDates = Array.from({ length: RECENT_DAYS }, (_, i) => this.usageService.getLocalDate(i));

    const [top, mine] = await Promise.all([
      this.usageService.getDailyTopUsers(today, TOP_N),
      this.usageService.getUserDailyBreakdown(String(context.userId), recentDates),
    ]);

    const content = [this.formatTopSection(today, top), '', this.formatMineSection(mine)].join('\n');

    const cardData: InfoCardData = {
      type: 'info',
      title: `Token 消耗统计 · ${today}`,
      content,
      level: 'info',
    };

    try {
      const segments = await this.aiService.renderCardToSegments(JSON.stringify(cardData));
      return { success: true, segments };
    } catch (err) {
      logger.warn('[UsageCommandHandler] Card render failed, falling back to text:', err);
      return { success: true, segments: new MessageBuilder().text(content).build() };
    }
  }

  private formatTopSection(today: string, top: UserUsageAgg[]): string {
    if (top.length === 0) {
      return `今日（${today}）暂无消耗记录`;
    }
    const lines = [`今日 Token 消耗 Top ${TOP_N}`];
    top.forEach((u, i) => {
      const name = u.nickname ? `${u.nickname} (${u.userId})` : u.userId;
      const head = `${String(i + 1).padStart(2, ' ')}. ${name} · ${this.fmt(u.totalTokens)} tok${
        u.totalImages > 0 ? ` · ${u.totalImages} 图` : ''
      }`;
      lines.push(head);
      const detail = this.formatProviderBreakdown(u.byProvider);
      if (detail) lines.push(`    ${detail}`);
    });
    return lines.join('\n');
  }

  private formatMineSection(mine: DailyUsageAgg[]): string {
    const lines = ['你的近三日消耗'];
    let sumTok = 0;
    let sumImg = 0;
    for (const day of mine) {
      sumTok += day.totalTokens;
      sumImg += day.totalImages;
      if (day.totalTokens === 0 && day.totalImages === 0) {
        lines.push(`${day.date} · 无`);
        continue;
      }
      lines.push(
        `${day.date} · ${this.fmt(day.totalTokens)} tok${day.totalImages > 0 ? ` · ${day.totalImages} 图` : ''}`,
      );
      const detail = this.formatProviderBreakdown(day.byProvider);
      if (detail) lines.push(`    ${detail}`);
    }
    lines.push(`${RECENT_DAYS} 天合计：${this.fmt(sumTok)} tok${sumImg > 0 ? ` · ${sumImg} 图` : ''}`);
    return lines.join('\n');
  }

  private formatProviderBreakdown(byProvider: ProviderUsageAgg[]): string {
    return byProvider
      .map((p) => (p.type === 'image' ? `${p.provider} ${p.imageCount}图` : `${p.provider} ${this.fmt(p.totalTokens)}`))
      .join(' · ');
  }

  private fmt(n: number): string {
    return n.toLocaleString('en-US');
  }
}
