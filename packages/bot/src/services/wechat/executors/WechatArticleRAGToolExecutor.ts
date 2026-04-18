// WeChat article RAG search — semantic search over chunked WeChat articles

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

const DEFAULT_COLLECTION = 'wechat_articles_chunks';
const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.4;
const MAX_CHUNK_DISPLAY_LEN = 500;

@Tool({
  name: 'wechat_article_rag',
  description:
    '从已收录的公众号文章库中语义搜索相关内容。' +
    '文章库持续更新，包含大量高质量的新闻资讯、行业分析和深度报道，覆盖科技、财经、时事等领域，时效性强。' +
    '适用于：1) 查找近期热点事件和新闻动态；2) 获取某个话题的高质量分析和观点；3) 作为联网搜索的补充知识源。' +
    '返回相关片段（非全文），含标题、来源和匹配段落。',
  executor: 'wechat_article_rag',
  visibility: ['subagent'],
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '语义搜索查询文本（自然语言描述要找的内容，如"AI对教育的影响"）',
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
  examples: ['最近有什么关于AI的新闻', '查找关于经济形势的分析', '搜索最近的科技行业动态'],
  whenToUse:
    '1) 用户询问近期热点、新闻、行业动态时，可使用本工具从已收录的高质量文章中检索，时效性优于自身知识库；' +
    '2) 作为 search（联网搜索）的补充：本工具的文章经过筛选，质量高于一般搜索结果，适合需要深度观点和分析的场景；' +
    '3) 使用语义向量搜索，能理解同义词和相近表述，适合模糊话题检索。',
})
@injectable()
export class WechatArticleRAGToolExecutor extends BaseToolExecutor {
  name = 'wechat_article_rag';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    if (!this.retrievalService.isRAGEnabled()) {
      return this.error('RAG 未启用，无法搜索微信文章', 'RAG is not enabled');
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

    logger.info(
      `[WechatArticleRAG] query="${query}" limit=${limit} minScore=${minScore} collection=${DEFAULT_COLLECTION}`,
    );

    try {
      const hits = await this.retrievalService.vectorSearch(DEFAULT_COLLECTION, query, {
        limit,
        minScore,
      });

      if (hits.length === 0) {
        return this.success('未找到相关微信文章内容。', {
          query,
          collection: DEFAULT_COLLECTION,
          results: [],
        });
      }

      const formatted = hits
        .map((hit, index) => {
          const p = hit.payload;
          const title = (p.title as string) || '未知标题';
          const source = (p.source as string) || (p.accountNick as string) || '';
          const chunkIndex = p.chunkIndex as number | undefined;
          const totalChunks = p.totalChunks as number | undefined;
          const url = (p.url as string) || '';
          const content = typeof hit.content === 'string' ? hit.content : '';
          const truncated =
            content.length > MAX_CHUNK_DISPLAY_LEN ? content.slice(0, MAX_CHUNK_DISPLAY_LEN) + '…' : content;

          const header = [
            `${index + 1}. 「${title}」`,
            source ? `来源: ${source}` : '',
            chunkIndex != null && totalChunks != null ? `片段 ${chunkIndex + 1}/${totalChunks}` : '',
            `相似度: ${hit.score.toFixed(3)}`,
            url ? `链接: ${url}` : '',
          ]
            .filter(Boolean)
            .join(' | ');

          return `${header}\n${truncated}`;
        })
        .join('\n\n');

      return this.success(formatted, {
        query,
        collection: DEFAULT_COLLECTION,
        resultCount: hits.length,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatArticleRAG] Error:', err);
      return this.error('搜索微信文章失败', errorMsg);
    }
  }
}
