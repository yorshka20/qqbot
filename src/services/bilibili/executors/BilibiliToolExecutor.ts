// Bilibili tool executor - allows LLM/subagent to search and fetch bilibili content

import { inject, injectable } from 'tsyringe';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import { BilibiliService } from '../BilibiliService';

@Tool({
  name: 'bilibili',
  description: '查询B站内容。支持搜索视频、获取视频详情、查看热门视频和热搜榜。返回视频标题、UP主、播放量等信息。',
  executor: 'bilibili',
  visibility: ['reply', 'subagent'],
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: '操作类型: "search"(搜索视频), "video"(视频详情), "popular"(热门), "hot"(热搜)',
    },
    query: {
      type: 'string',
      required: false,
      description: '搜索关键词(action=search时必填)或BV号/链接(action=video时必填)',
    },
  },
  examples: ['搜一下B站上的Minecraft视频', '查看这个B站视频 BV1xx411c7mD', 'B站现在什么最火'],
  triggerKeywords: ['B站', 'b站', 'bilibili', '哔哩哔哩'],
  whenToUse: '当用户询问B站/bilibili相关内容、想看视频信息、搜索B站视频或查看热门内容时调用。',
})
@injectable()
export class BilibiliToolExecutor extends BaseToolExecutor {
  name = 'bilibili';

  constructor(@inject('BilibiliService') private bilibiliService: BilibiliService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const action = call.parameters?.action as string | undefined;
    const query = call.parameters?.query as string | undefined;

    if (!action) {
      return this.error('请指定操作类型', 'Missing required parameter: action');
    }

    try {
      switch (action) {
        case 'search':
          return this.handleSearch(query);
        case 'video':
          return this.handleVideo(query);
        case 'popular':
          return this.handlePopular();
        case 'hot':
          return this.handleHotSearch();
        default:
          return this.error(`未知操作: ${action}`, `Unknown action: ${action}. Use search/video/popular/hot`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[BilibiliTool] Error in action=${action}:`, err);
      return this.error(`B站查询失败: ${err.message}`, err.message);
    }
  }

  private async handleSearch(query: string | undefined): Promise<ToolResult> {
    if (!query?.trim()) {
      return this.error('请提供搜索关键词', 'Missing required parameter: query for search action');
    }

    const searchData = await this.bilibiliService.searchVideos(query, 1, 5);
    if (!searchData.result?.length) {
      return this.success(`未找到与「${query}」相关的视频`, { query, results: [] });
    }

    const formatted = searchData.result
      .map((item, i) => this.bilibiliService.formatSearchItem(item, i + 1))
      .join('\n\n');

    return this.success(`B站搜索「${query}」结果:\n\n${formatted}\n\n共 ${searchData.numResults} 条结果`, {
      query,
      resultCount: searchData.numResults,
    });
  }

  private async handleVideo(query: string | undefined): Promise<ToolResult> {
    if (!query) {
      return this.error('请提供BV号或视频链接', 'Missing required parameter: query for video action');
    }

    const bvid = BilibiliService.extractBvid(query);
    if (!bvid) {
      return this.error(`无法解析视频ID: ${query}`, `Cannot parse bvid from: ${query}`);
    }

    const video = await this.bilibiliService.getVideoDetail(bvid);
    const formatted = this.bilibiliService.formatVideoDetail(video);

    return this.success(formatted, { bvid, title: video.title, owner: video.owner.name });
  }

  private async handlePopular(): Promise<ToolResult> {
    const videos = await this.bilibiliService.getPopularVideos(1, 5);
    if (!videos.length) {
      return this.success('暂无热门视频数据', { results: [] });
    }

    const formatted = videos.map((v, i) => this.bilibiliService.formatVideoItem(v, i + 1)).join('\n\n');

    return this.success(`B站热门视频:\n\n${formatted}`, { resultCount: videos.length });
  }

  private async handleHotSearch(): Promise<ToolResult> {
    const data = await this.bilibiliService.getHotSearch();
    if (data.code !== 0 || !data.list?.length) {
      return this.success('暂无热搜数据', { results: [] });
    }

    const items = data.list.slice(0, 10);
    const formatted = items
      .map((item) => {
        const keyword = item.show_name || item.keyword;
        const heat = this.bilibiliService.formatCount(item.heat_score);
        return `${item.pos}. ${keyword} (热度: ${heat})`;
      })
      .join('\n');

    return this.success(`B站热搜榜:\n\n${formatted}`, { resultCount: items.length });
  }
}
