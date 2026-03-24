import { inject, injectable } from 'tsyringe';
import { MessageBuilder } from '@/message/MessageBuilder';
import { BilibiliService } from '@/services/bilibili';
import { logger } from '@/utils/logger';
import { Command } from '../decorators';
import type { CommandContext, CommandHandler, CommandResult } from '../types';

/**
 * Bilibili command handler - supports multiple subcommands:
 *   /b站           - 热搜榜 (default)
 *   /b站 热搜       - 热搜榜
 *   /b站 热门       - 热门视频
 *   /b站 搜索 <kw>  - 搜索视频
 *   /b站 视频 <bvid> - 视频详情
 */
@Command({
  name: 'b站',
  description: 'Bilibili功能：热搜/热门/搜索/视频详情',
  usage: '/b站 [热搜|热门|搜索 <关键词>|视频 <BV号或链接>]',
  permissions: ['user'],
  aliases: ['B站', 'bilibili'],
})
@injectable()
export class BilibiliHotCommandHandler implements CommandHandler {
  name = 'b站';
  description = 'Bilibili功能：热搜/热门/搜索/视频详情';
  usage = '/b站 [热搜|热门|搜索 <关键词>|视频 <BV号或链接>]';

  constructor(@inject('BilibiliService') private bilibiliService: BilibiliService) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const subcommand = args[0] || '热搜';
    const subArgs = args.slice(1);

    try {
      switch (subcommand) {
        case '热搜':
          return this.handleHotSearch();
        case '热门':
          return this.handlePopular();
        case '搜索':
        case 'search':
          return this.handleSearch(subArgs.join(' '));
        case '视频':
        case 'video': {
          return this.handleVideoDetail(subArgs[0]);
        }
        default: {
          // If the first arg looks like a BV id or URL, treat as video detail
          const bvid = BilibiliService.extractBvid(subcommand);
          if (bvid) {
            return this.handleVideoDetail(subcommand);
          }
          // Otherwise treat all args as a search keyword
          return this.handleSearch(args.join(' '));
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[BilibiliCommand] Error:', err);
      return { success: false, error: `B站请求失败: ${err.message}` };
    }
  }

  private async handleHotSearch(): Promise<CommandResult> {
    logger.info('[BilibiliCommand] Fetching hot search');
    const data = await this.bilibiliService.getHotSearch();

    if (data.code !== 0 || !data.list?.length) {
      return { success: false, error: '获取热搜失败或列表为空' };
    }

    const builder = new MessageBuilder();
    builder.text('🔥 B站热搜榜\n');
    builder.text('━━━━━━━━━━━━━━━━\n\n');

    for (let i = 0; i < Math.min(data.list.length, 10); i++) {
      const item = data.list[i];
      const keyword = item.show_name || item.keyword;
      const heat = this.bilibiliService.formatCount(item.heat_score);

      let rankEmoji: string;
      if (item.pos === 1) rankEmoji = '🥇';
      else if (item.pos === 2) rankEmoji = '🥈';
      else if (item.pos === 3) rankEmoji = '🥉';
      else rankEmoji = `${item.pos}.`;

      builder.text(`${rankEmoji} ${keyword}\n`);
      builder.text(`  热度: ${heat}\n`);
      if (i < Math.min(data.list.length, 10) - 1) {
        builder.text('\n');
      }
    }

    builder.text('\n━━━━━━━━━━━━━━━━');
    return { success: true, segments: builder.build() };
  }

  private async handlePopular(): Promise<CommandResult> {
    logger.info('[BilibiliCommand] Fetching popular videos');
    const videos = await this.bilibiliService.getPopularVideos(1, 10);

    if (!videos.length) {
      return { success: false, error: '获取热门视频失败' };
    }

    const builder = new MessageBuilder();
    builder.text('📺 B站热门视频\n');
    builder.text('━━━━━━━━━━━━━━━━\n\n');

    for (let i = 0; i < videos.length; i++) {
      builder.text(this.bilibiliService.formatVideoItem(videos[i], i + 1));
      if (i < videos.length - 1) {
        builder.text('\n\n');
      }
    }

    builder.text('\n\n━━━━━━━━━━━━━━━━');
    return { success: true, segments: builder.build() };
  }

  private async handleSearch(keyword: string): Promise<CommandResult> {
    if (!keyword.trim()) {
      return { success: false, error: '请输入搜索关键词，例如: /b站 搜索 原神' };
    }

    logger.info(`[BilibiliCommand] Searching: "${keyword}"`);
    const searchData = await this.bilibiliService.searchVideos(keyword, 1, 10);

    if (!searchData.result?.length) {
      return { success: false, error: `未找到与「${keyword}」相关的视频` };
    }

    const builder = new MessageBuilder();
    builder.text(`🔍 搜索: ${keyword}\n`);
    builder.text('━━━━━━━━━━━━━━━━\n\n');

    for (let i = 0; i < searchData.result.length; i++) {
      builder.text(this.bilibiliService.formatSearchItem(searchData.result[i], i + 1));
      if (i < searchData.result.length - 1) {
        builder.text('\n\n');
      }
    }

    builder.text(`\n\n━━━━━━━━━━━━━━━━\n共 ${searchData.numResults} 条结果`);
    return { success: true, segments: builder.build() };
  }

  private async handleVideoDetail(input: string | undefined): Promise<CommandResult> {
    if (!input) {
      return { success: false, error: '请提供BV号或视频链接，例如: /b站 视频 BV1xx411c7mD' };
    }

    const bvid = BilibiliService.extractBvid(input);
    if (!bvid) {
      return { success: false, error: `无法解析视频ID: ${input}` };
    }

    logger.info(`[BilibiliCommand] Fetching video detail: ${bvid}`);
    const video = await this.bilibiliService.getVideoDetail(bvid);

    const builder = new MessageBuilder();

    // Add cover image
    if (video.pic) {
      const pic = video.pic.startsWith('//') ? `https:${video.pic}` : video.pic;
      builder.image({ url: pic });
      builder.text('\n');
    }

    builder.text(this.bilibiliService.formatVideoDetail(video));

    return { success: true, segments: builder.build() };
  }
}
