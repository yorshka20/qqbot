import { injectable } from 'tsyringe';
import { HttpClient } from '@/api/http/HttpClient';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

// Fetch hot search data from Bilibili API
type BilibiliHotSearchResponse = {
  code: number;
  list?: Array<{
    keyword: string;
    show_name: string;
    heat_score: number;
    pos: number;
    icon?: string;
  }>;
};

/**
 * Bilibili hot search command - fetches B站热搜列表 and sends as card messages
 */
@Command({
  name: 'b站',
  description: 'Get Bilibili hot search list',
  usage: '/b站',
  permissions: ['user'], // All users can use this command
  aliases: ['B站'],
})
@injectable()
export class BilibiliHotCommandHandler implements CommandHandler {
  name = 'b站';
  description = 'Get Bilibili hot search list';
  usage = '/b站';

  private readonly API_URL = 'https://s.search.bilibili.com/main/hotword';
  private readonly httpClient: HttpClient;

  constructor() {
    // Configure HttpClient for Bilibili API
    this.httpClient = new HttpClient({
      baseURL: this.API_URL,
      defaultHeaders: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      defaultTimeout: 10000, // 10 seconds default timeout
    });
  }

  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    try {
      logger.info('[BilibiliHotCommandHandler] Fetching Bilibili hot search list');

      const data = await this.httpClient.get<BilibiliHotSearchResponse>('');

      if (data.code !== 0 || !data.list || data.list.length === 0) {
        return {
          success: false,
          error: 'Failed to fetch hot search list or list is empty',
        };
      }

      const messageBuilder = new MessageBuilder();

      messageBuilder.text('🔥 B站热搜榜\n');
      messageBuilder.text('━━━━━━━━━━━━━━━━\n\n');

      // Format each item as a card (limit to top 10)
      for (let i = 0; i < Math.min(data.list.length, 10); i++) {
        const item = data.list[i];
        const rank = item.pos;
        const keyword = item.show_name || item.keyword;
        const heatScore = item.heat_score;

        // Rank indicator with emoji
        let rankEmoji = '';
        if (rank === 1) rankEmoji = '🥇';
        else if (rank === 2) rankEmoji = '🥈';
        else if (rank === 3) rankEmoji = '🥉';
        else rankEmoji = `${rank}.`;

        // Format heat score
        const formattedHeat = this.formatHeatScore(heatScore);

        // Card format: rank + keyword + heat score + link
        messageBuilder.text(`${rankEmoji} ${keyword}\n`);
        messageBuilder.text(`  热度: ${formattedHeat}\n`);

        // Add separator between items (except for the last one)
        if (i < Math.min(data.list.length, 10) - 1) {
          messageBuilder.text('\n');
        }
      }

      messageBuilder.text('\n━━━━━━━━━━━━━━━━');

      const messageSegments = messageBuilder.build();

      return {
        success: true,
        segments: messageSegments,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[BilibiliHotCommandHandler] Failed to fetch hot search list:', err);
      return {
        success: false,
        error: `Failed to fetch hot search list: ${err.message}`,
      };
    }
  }

  /**
   * Format heat score to readable format
   */
  private formatHeatScore(score: number): string {
    if (score >= 1000000) {
      return `${(score / 1000000).toFixed(1)}M`;
    } else if (score >= 1000) {
      return `${(score / 1000).toFixed(1)}K`;
    }
    return score.toString();
  }
}
