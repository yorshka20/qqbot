// WeChat moments semantic search — search over personal moments in Qdrant

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

const COLLECTION = 'wechat_moments';
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_SCORE = 0.35;
const MAX_CONTENT_DISPLAY_LEN = 800;

@Tool({
  name: 'wechat_moments_search',
  description:
    '从用户的微信朋友圈历史中语义搜索相关内容。' +
    '朋友圈数据库包含约7800+条记录，时间跨度覆盖多年，涵盖用户对各种话题的思考和记录。' +
    '适用于：1) 查找用户在某个话题上发过什么；2) 了解用户的兴趣和关注点；3) 追溯用户对某件事的看法变化。' +
    '返回按时间排序的匹配条目，含发布时间、正文内容和相似度评分。' +
    '支持多关键词搜索：传入多个 query 可以从不同角度检索同一话题（如 topic 的不同表述），结果会自动去重合并。',
  executor: 'wechat_moments_search',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '主搜索查询（自然语言，如"AI本地部署的看法"、"对工作和生活的思考"）',
    },
    additionalQueries: {
      type: 'string',
      required: false,
      description:
        '补充查询，用 | 分隔多个角度的搜索词（如"深度学习|机器学习|神经网络"），与主 query 一起做多角度检索',
    },
    limit: {
      type: 'number',
      required: false,
      description: `最大返回条数，默认 ${DEFAULT_LIMIT}`,
    },
    minScore: {
      type: 'number',
      required: false,
      description: `最低相似度阈值（0-1），默认 ${DEFAULT_MIN_SCORE}`,
    },
  },
  examples: [
    '搜索我的朋友圈里关于AI的内容',
    '我以前发过什么关于旅行的朋友圈',
    '查找我朋友圈中讨论音乐的部分',
    '我对创业这件事说过什么',
  ],
  whenToUse:
    '当需要从用户的个人朋友圈历史中查找内容时使用。' +
    '与 wechat_article_rag（搜索公众号文章）不同，本工具搜索的是用户自己发布的朋友圈动态。' +
    '适合回答「我说过什么」「我怎么看XX」「我的朋友圈里有没有关于XX的内容」这类问题。',
})
@injectable()
export class WechatMomentsSearchToolExecutor extends BaseToolExecutor {
  name = 'wechat_moments_search';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    if (!this.retrievalService.isRAGEnabled()) {
      return this.error('RAG 未启用，无法搜索朋友圈', 'RAG is not enabled');
    }

    const query = typeof call.parameters?.query === 'string' ? call.parameters.query.trim() : '';
    if (!query) {
      return this.error('请提供要搜索的内容', 'Missing required parameter: query');
    }

    const limit =
      typeof call.parameters?.limit === 'number' && Number.isFinite(call.parameters.limit)
        ? Math.max(1, Math.floor(call.parameters.limit))
        : DEFAULT_LIMIT;
    const minScore =
      typeof call.parameters?.minScore === 'number' && Number.isFinite(call.parameters.minScore)
        ? call.parameters.minScore
        : DEFAULT_MIN_SCORE;

    // Parse additional queries
    const additionalQueriesRaw =
      typeof call.parameters?.additionalQueries === 'string'
        ? call.parameters.additionalQueries.trim()
        : '';
    const additionalQueries = additionalQueriesRaw
      ? additionalQueriesRaw.split('|').map((q) => q.trim()).filter(Boolean)
      : [];

    logger.info(
      `[WechatMomentsSearch] query="${query}" additional=[${additionalQueries.join(', ')}] limit=${limit} minScore=${minScore}`,
    );

    try {
      let hits;
      if (additionalQueries.length > 0) {
        const allQueries = [query, ...additionalQueries];
        hits = await this.retrievalService.vectorSearchMulti(COLLECTION, allQueries, {
          limitPerQuery: limit,
          maxTotal: limit,
          minScore,
        });
      } else {
        hits = await this.retrievalService.vectorSearch(COLLECTION, query, { limit, minScore });
      }

      if (hits.length === 0) {
        return this.success('未找到相关的朋友圈内容。', { query, results: [] });
      }

      // Sort by create_time ascending (timeline order)
      hits.sort((a, b) => {
        const ta = (a.payload?.create_time as string) || '';
        const tb = (b.payload?.create_time as string) || '';
        return ta.localeCompare(tb);
      });

      const formatted = hits
        .map((hit, index) => {
          const createTime = (hit.payload?.create_time as string) || '未知时间';
          const content = typeof hit.content === 'string' ? hit.content : '';
          const truncated =
            content.length > MAX_CONTENT_DISPLAY_LEN
              ? content.slice(0, MAX_CONTENT_DISPLAY_LEN) + '…'
              : content;

          return `[${index + 1}] 时间: ${createTime}  相似度: ${hit.score.toFixed(3)}\n${truncated}`;
        })
        .join('\n\n');

      const times = hits
        .map((h) => (h.payload?.create_time as string) || '')
        .filter(Boolean)
        .sort();

      return this.success(formatted, {
        query,
        resultCount: hits.length,
        timeRange: times.length > 0 ? { earliest: times[0], latest: times[times.length - 1] } : null,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatMomentsSearch] Error:', err);
      return this.error('搜索朋友圈失败', errorMsg);
    }
  }
}
