// Bilibili API service
// Provides direct access to bilibili's APIs with WBI signing and anti-scraping handling.

import { injectable } from 'tsyringe';
import { HttpClient } from '@/api/http/HttpClient';
import { logger } from '@/utils/logger';
import type {
  BilibiliAPIResponse,
  BilibiliCommentData,
  BilibiliHotSearchResponse,
  BilibiliPopularData,
  BilibiliSearchData,
  BilibiliVideoItem,
} from './types';
import { signWbiParams } from './wbi';

const BILIBILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com',
  Origin: 'https://www.bilibili.com',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

@injectable()
export class BilibiliService {
  private readonly httpClient: HttpClient;
  private readonly hotSearchClient: HttpClient;

  constructor() {
    this.httpClient = new HttpClient({
      baseURL: 'https://api.bilibili.com',
      defaultHeaders: BILIBILI_HEADERS,
      defaultTimeout: 15000,
    });
    this.hotSearchClient = new HttpClient({
      baseURL: 'https://s.search.bilibili.com/main/hotword',
      defaultHeaders: BILIBILI_HEADERS,
      defaultTimeout: 10000,
    });
  }

  /**
   * Fetch hot search trending keywords.
   */
  async getHotSearch(): Promise<BilibiliHotSearchResponse> {
    logger.debug('[BilibiliService] Fetching hot search');
    return this.hotSearchClient.get<BilibiliHotSearchResponse>('');
  }

  /**
   * Fetch popular/trending videos.
   */
  async getPopularVideos(page = 1, pageSize = 20): Promise<BilibiliVideoItem[]> {
    logger.debug(`[BilibiliService] Fetching popular videos page=${page}`);
    const data = await this.httpClient.get<BilibiliAPIResponse<BilibiliPopularData>>(
      `/x/web-interface/popular?pn=${page}&ps=${pageSize}`,
    );
    if (data.code !== 0) {
      throw new Error(`Bilibili API error: ${data.message}`);
    }
    return data.data.list;
  }

  /**
   * Search videos by keyword (WBI-signed).
   */
  async searchVideos(keyword: string, page = 1, pageSize = 20): Promise<BilibiliSearchData> {
    logger.debug(`[BilibiliService] Searching videos: "${keyword}" page=${page}`);
    const signedQuery = await signWbiParams({
      keyword,
      search_type: 'video',
      page,
      page_size: pageSize,
    });
    const data = await this.httpClient.get<BilibiliAPIResponse<BilibiliSearchData>>(
      `/x/web-interface/wbi/search/type?${signedQuery}`,
    );
    if (data.code !== 0) {
      throw new Error(`Bilibili search API error: ${data.message}`);
    }
    return data.data;
  }

  /**
   * Get video detail by BV id.
   */
  async getVideoDetail(bvid: string): Promise<BilibiliVideoItem> {
    logger.debug(`[BilibiliService] Fetching video detail: ${bvid}`);
    const data = await this.httpClient.get<BilibiliAPIResponse<BilibiliVideoItem>>(
      `/x/web-interface/view?bvid=${bvid}`,
    );
    if (data.code !== 0) {
      throw new Error(`Bilibili video API error: ${data.message}`);
    }
    return data.data;
  }

  /**
   * Get video comments.
   */
  async getVideoComments(aid: number, mode: 'hot' | 'time' = 'hot', offset = ''): Promise<BilibiliCommentData> {
    logger.debug(`[BilibiliService] Fetching comments for aid=${aid} mode=${mode}`);
    const modeNum = mode === 'hot' ? 3 : 2;
    const paginationStr = JSON.stringify({ offset });
    const data = await this.httpClient.get<BilibiliAPIResponse<BilibiliCommentData>>(
      `/x/v2/reply/main?oid=${aid}&type=1&mode=${modeNum}&plat=1&pagination_str=${encodeURIComponent(paginationStr)}`,
    );
    if (data.code !== 0) {
      throw new Error(`Bilibili comment API error: ${data.message}`);
    }
    return data.data;
  }

  // ── Formatting helpers ──

  /**
   * Format a video item into a readable text block.
   */
  formatVideoItem(video: BilibiliVideoItem, index?: number): string {
    const prefix = index !== undefined ? `${index}. ` : '';
    const views = this.formatCount(video.stat.view);
    const danmaku = this.formatCount(video.stat.danmaku);
    const likes = this.formatCount(video.stat.like);
    const duration = this.formatDuration(video.duration);

    return [
      `${prefix}${video.title}`,
      `  UP: ${video.owner.name} | ${duration} | ${views}播放 ${danmaku}弹幕 ${likes}赞`,
      `  https://www.bilibili.com/video/${video.bvid}`,
    ].join('\n');
  }

  /**
   * Format a search result item into a readable text block.
   */
  formatSearchItem(item: BilibiliSearchData['result'][0], index: number): string {
    // Strip HTML tags from search result titles
    const title = item.title.replace(/<[^>]+>/g, '');
    const views = this.formatCount(item.play);
    const danmaku = this.formatCount(item.video_review);

    return [
      `${index}. ${title}`,
      `  UP: ${item.author} | ${item.duration} | ${views}播放 ${danmaku}弹幕`,
      `  https://www.bilibili.com/video/${item.bvid}`,
    ].join('\n');
  }

  /**
   * Format video detail into a comprehensive text block.
   */
  formatVideoDetail(video: BilibiliVideoItem): string {
    const views = this.formatCount(video.stat.view);
    const danmaku = this.formatCount(video.stat.danmaku);
    const likes = this.formatCount(video.stat.like);
    const coins = this.formatCount(video.stat.coin);
    const favorites = this.formatCount(video.stat.favorite);
    const replies = this.formatCount(video.stat.reply);
    const duration = this.formatDuration(video.duration);
    const pubdate = video.pubdate ? new Date(video.pubdate * 1000).toLocaleDateString('zh-CN') : '';

    const lines = [
      `📺 ${video.title}`,
      '',
      `UP主: ${video.owner.name}`,
      `时长: ${duration}${pubdate ? ` | 发布: ${pubdate}` : ''}`,
      `播放: ${views} | 弹幕: ${danmaku} | 评论: ${replies}`,
      `点赞: ${likes} | 投币: ${coins} | 收藏: ${favorites}`,
    ];

    if (video.desc) {
      const desc = video.desc.length > 200 ? `${video.desc.slice(0, 200)}...` : video.desc;
      lines.push('', `简介: ${desc}`);
    }

    lines.push('', `🔗 https://www.bilibili.com/video/${video.bvid}`);

    return lines.join('\n');
  }

  /**
   * Format a number into a human-readable count string.
   */
  formatCount(count: number): string {
    if (count >= 100000000) {
      return `${(count / 100000000).toFixed(1)}亿`;
    }
    if (count >= 10000) {
      return `${(count / 10000).toFixed(1)}万`;
    }
    return count.toString();
  }

  /**
   * Format seconds into mm:ss or hh:mm:ss.
   */
  formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Extract BV id from a bilibili URL or raw BV string.
   */
  static extractBvid(input: string): string | null {
    // Direct BV id
    if (/^BV[a-zA-Z0-9]+$/.test(input)) {
      return input;
    }
    // URL pattern
    const match = input.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
    return match?.[1] ?? null;
  }
}
