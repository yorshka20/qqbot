import { inject, injectable } from 'tsyringe';
import { MessageBuilder } from '@/message/MessageBuilder';
import { BilibiliService } from '@/services/bilibili';
import type { VideoKnowledgeClient } from '@/services/bilibili/VideoKnowledgeClient';
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
 *   /b站 分析 <bvid> - 提交视频分析任务
 *   /b站 分析状态 <task_id> - 查询分析任务状态
 */
@Command({
  name: 'b站',
  description: 'Bilibili功能：热搜/热门/搜索/视频详情/视频分析',
  usage: '/b站 [热搜|热门|搜索 <关键词>|视频 <BV号或链接>|分析 <BV号或链接>|分析状态 <任务ID>]',
  permissions: ['user'],
  aliases: ['B站', 'bilibili'],
})
@injectable()
export class BilibiliHotCommandHandler implements CommandHandler {
  name = 'b站';
  description = 'Bilibili功能：热搜/热门/搜索/视频详情/视频分析';
  usage = '/b站 [热搜|热门|搜索 <关键词>|视频 <BV号或链接>|分析 <BV号或链接>|分析状态 <任务ID>]';

  constructor(
    @inject('BilibiliService') private bilibiliService: BilibiliService,
    @inject('VideoKnowledgeClient') private videoKnowledgeClient: VideoKnowledgeClient,
  ) {}

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
        case '分析':
        case 'analyze':
          return this.handleAnalyze(subArgs[0]);
        case '分析状态':
        case 'task':
          return this.handleTaskStatus(subArgs[0]);
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

  private async handleAnalyze(input: string | undefined): Promise<CommandResult> {
    if (!this.videoKnowledgeClient.isEnabled()) {
      return { success: false, error: '视频分析服务未启用，请在配置中启用 videoKnowledge' };
    }

    if (!input) {
      return { success: false, error: '请提供BV号或视频链接，例如: /b站 分析 BV1xx411c7mD' };
    }

    const bvid = BilibiliService.extractBvid(input);
    if (!bvid) {
      return { success: false, error: `无法解析视频ID: ${input}` };
    }

    // Check backend health first
    const healthy = await this.videoKnowledgeClient.healthCheck();
    if (!healthy) {
      return { success: false, error: '视频分析服务暂时不可用，请稍后再试' };
    }

    logger.info(`[BilibiliCommand] Submitting analysis for ${bvid}`);

    // Submit analysis task
    const { task_id } = await this.videoKnowledgeClient.submitAnalysis(bvid);

    const builder = new MessageBuilder();
    builder.text(`🔬 已提交视频分析任务 #${task_id}\n`);
    builder.text(`视频: ${bvid}\n`);
    builder.text('正在分析中，请稍候...\n');

    // Poll for result
    const pollResult = await this.videoKnowledgeClient.pollTaskResult(task_id);

    if (!pollResult.success) {
      builder.text(`\n❌ ${pollResult.error}`);
      if (pollResult.task?.status === 'failed') {
        builder.text(`\n可使用 /b站 分析状态 ${task_id} 查看详情`);
      } else {
        builder.text(`\n任务仍在处理中，可使用 /b站 分析状态 ${task_id} 查询进度`);
      }
      return { success: true, segments: builder.build() };
    }

    // Try to read the result from local filesystem
    const result = this.videoKnowledgeClient.readResult(bvid);
    if (result) {
      builder.text('\n✅ 分析完成\n\n');
      builder.text(this.videoKnowledgeClient.formatResult(result));
    } else {
      builder.text('\n✅ 分析完成，但未找到结果文件');
      builder.text(`\n任务ID: ${task_id}`);
    }

    return { success: true, segments: builder.build() };
  }

  private async handleTaskStatus(input: string | undefined): Promise<CommandResult> {
    if (!this.videoKnowledgeClient.isEnabled()) {
      return { success: false, error: '视频分析服务未启用，请在配置中启用 videoKnowledge' };
    }

    if (!input) {
      return { success: false, error: '请提供任务ID，例如: /b站 分析状态 12345' };
    }

    const taskId = parseInt(input, 10);
    if (Number.isNaN(taskId)) {
      return { success: false, error: `无效的任务ID: ${input}` };
    }

    logger.info(`[BilibiliCommand] Querying task status: ${taskId}`);
    const task = await this.videoKnowledgeClient.getTaskStatus(taskId);

    const statusMap: Record<string, string> = {
      queued: '⏳ 等待处理',
      claimed: '⚙️ 正在处理中',
      done: '✅ 分析完成',
      failed: '❌ 分析失败',
    };

    const builder = new MessageBuilder();
    builder.text(`📊 任务 #${task.id} 状态\n`);
    builder.text('━━━━━━━━━━━━━━━━\n\n');
    builder.text(`状态: ${statusMap[task.status] || task.status}\n`);
    builder.text(`类型: ${task.type}\n`);
    builder.text(`优先级: ${task.priority}\n`);
    builder.text(`创建时间: ${task.created_at}\n`);

    if (task.claimed_at) {
      builder.text(`开始处理: ${task.claimed_at}\n`);
    }
    if (task.done_at) {
      builder.text(`完成时间: ${task.done_at}\n`);
    }
    if (task.retry_count > 0) {
      builder.text(`重试次数: ${task.retry_count}\n`);
    }
    if (task.error_msg) {
      builder.text(`\n错误信息: ${task.error_msg}`);
    }

    return { success: true, segments: builder.build() };
  }
}
