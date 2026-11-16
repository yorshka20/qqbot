// Bilibili tool executor - allows LLM/subagent to search and fetch bilibili content

import { logger } from '@qqbot/shared';
import { inject, injectable } from 'tsyringe';
import { VideoKnowledgeClient } from '@/services/bilibili/VideoKnowledgeClient';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { BilibiliService } from '../BilibiliService';

// How long action=analyze waits for the backend to finish; kept under the tool's timeoutMs so a
// still-running analysis is reported as pending instead of being cut off by the tool deadline.
const ANALYZE_WAIT_MS = 300_000;

@Tool({
  name: 'bilibili',
  description:
    '查询B站内容。支持搜索视频、获取视频详情、查看热门视频、热搜榜、以及提交视频分析任务。返回视频标题、UP主、播放量等信息。action=analyze 要等后端跑完分析，通常需要几分钟。',
  executor: 'bilibili',
  // Sized for analyze, which waits on the video-knowledge backend's task stream for up to
  // ANALYZE_WAIT_MS. search/video/popular/hot are bounded well below this by their own 8s
  // network deadline.
  timeoutMs: 360_000,
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
  parameters: {
    action: {
      type: 'string',
      required: true,
      description:
        '操作类型: "search"(搜索视频), "video"(视频详情), "popular"(热门), "hot"(热搜), "analyze"(提交视频分析)',
    },
    query: {
      type: 'string',
      required: false,
      description:
        '搜索关键词(action=search时必填)、BV号/链接(action=video时必填)、用户发的视频链接或分享文本原样传入(action=analyze时必填，短链、av号均可)',
    },
  },
  examples: [
    '搜一下B站上的Minecraft视频',
    '查看这个B站视频 BV1xx411c7mD',
    'B站现在什么最火',
    '分析这个B站视频 BV1xx411c7mD',
  ],
  triggerKeywords: ['B站', 'b站', 'bilibili', '哔哩哔哩'],
  whenToUse: '当用户询问B站/bilibili相关内容、想看视频信息、搜索B站视频、查看热门内容、或需要分析视频内容时调用。',
})
@injectable()
export class BilibiliToolExecutor extends BaseToolExecutor {
  name = 'bilibili';

  constructor(
    @inject(BilibiliService) private bilibiliService: BilibiliService,
    @inject(VideoKnowledgeClient) private videoKnowledgeClient: VideoKnowledgeClient,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const action = call.parameters?.action as string | undefined;
    const query = call.parameters?.query as string | undefined;

    if (!action) {
      return this.error('请指定操作类型', 'Missing required parameter: action');
    }

    try {
      switch (action) {
        case 'search':
          return this.handleSearch(query, context.signal);
        case 'video':
          return this.handleVideo(query, context.signal);
        case 'popular':
          return this.handlePopular(context.signal);
        case 'hot':
          return this.handleHotSearch(context.signal);
        case 'analyze':
          return this.handleAnalyze(query, context.signal);
        default:
          return this.error(`未知操作: ${action}`, `Unknown action: ${action}. Use search/video/popular/hot/analyze`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[BilibiliTool] Error in action=${action}:`, err);
      return this.error(`B站查询失败: ${err.message}`, err.message);
    }
  }

  private async handleSearch(query: string | undefined, signal?: AbortSignal): Promise<ToolResult> {
    if (!query?.trim()) {
      return this.error('请提供搜索关键词', 'Missing required parameter: query for search action');
    }

    const searchData = await this.bilibiliService.searchVideos(query, 1, 5, signal);
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

  private async handleVideo(query: string | undefined, signal?: AbortSignal): Promise<ToolResult> {
    if (!query) {
      return this.error('请提供BV号或视频链接', 'Missing required parameter: query for video action');
    }

    const bvid = BilibiliService.extractBvid(query);
    if (!bvid) {
      return this.error(`无法解析视频ID: ${query}`, `Cannot parse bvid from: ${query}`);
    }

    const video = await this.bilibiliService.getVideoDetail(bvid, signal);
    const formatted = this.bilibiliService.formatVideoDetail(video);

    return this.success(formatted, { bvid, title: video.title, owner: video.owner.name });
  }

  private async handlePopular(signal?: AbortSignal): Promise<ToolResult> {
    const videos = await this.bilibiliService.getPopularVideos(1, 5, signal);
    if (!videos.length) {
      return this.success('暂无热门视频数据', { results: [] });
    }

    const formatted = videos.map((v, i) => this.bilibiliService.formatVideoItem(v, i + 1)).join('\n\n');

    return this.success(`B站热门视频:\n\n${formatted}`, { resultCount: videos.length });
  }

  private async handleHotSearch(signal?: AbortSignal): Promise<ToolResult> {
    const data = await this.bilibiliService.getHotSearch(signal);
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

  private async handleAnalyze(query: string | undefined, signal?: AbortSignal): Promise<ToolResult> {
    if (!this.videoKnowledgeClient.isEnabled()) {
      return this.error('视频分析服务未启用', 'Video knowledge backend is not enabled in config');
    }

    if (!query?.trim()) {
      return this.error('请提供BV号或视频链接', 'Missing required parameter: query for analyze action');
    }

    const healthy = await this.videoKnowledgeClient.healthCheck();
    if (!healthy) {
      return this.error('视频分析服务暂时不可用', 'Video knowledge backend health check failed');
    }

    const submitted = await this.videoKnowledgeClient.submitAnalysis(query);
    if (submitted.status === 'unresolvable') {
      return this.error(`无法识别视频链接: ${query}`, submitted.error);
    }

    const meta = { taskId: submitted.task_id, videoId: submitted.video_id };
    switch (submitted.status) {
      case 'analyzed':
        return this.success(`该视频此前已分析过:\n\n${this.videoKnowledgeClient.formatAnalysis(submitted.analysis)}`, {
          ...meta,
          status: 'analyzed',
          summary: submitted.analysis.result?.summary,
        });
      case 'held':
        return this.success(
          `视频 ${submitted.video_id} 分析连续失败，已停止自动重试${submitted.error ? `。最后一次失败: ${submitted.error}` : ''}`,
          { ...meta, status: 'held', error: submitted.error },
        );
      case 'queued':
      case 'active':
        break;
    }

    const outcome = await this.videoKnowledgeClient.waitForTask(submitted.task_id, {
      timeoutMs: ANALYZE_WAIT_MS,
      signal,
    });
    switch (outcome.status) {
      case 'complete':
        return this.success(`视频分析完成:\n\n${this.videoKnowledgeClient.formatAnalysis(outcome.analysis)}`, {
          ...meta,
          status: 'done',
          summary: outcome.analysis.result?.summary,
        });
      case 'failed':
        return this.success(`视频分析任务 #${submitted.task_id} 失败: ${outcome.error}`, {
          ...meta,
          status: 'failed',
          error: outcome.error,
        });
      case 'timeout':
        return this.success(`视频分析任务 #${submitted.task_id} 仍在处理中，可稍后查询任务状态。`, {
          ...meta,
          status: 'pending',
        });
    }
  }
}
