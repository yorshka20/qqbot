// RAG search task executor - retrieves local vector-store results for the current conversation or a named collection

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { QdrantClient, type RetrievalService } from '@/services/retrieval';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'rag_search',
  description:
    '按**语义**检索群聊历史：用自然语言描述你要找的意思，向量相似度返回最接近的若干片段（每条带相似度分数）。返回的是片段本身，**不带时间和发言人**，也不保证覆盖全部相关消息——只是最相似的 top-K。',
  executor: 'rag_search',
  visibility: { subagent: true },
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '用自然语言描述要找的**意思**，不是字面词——匹配靠语义相近，原话用词不同也能命中。',
    },
    collection: {
      type: 'string',
      required: false,
      description: '知识集合名称。省略则搜索当前群的聊天历史集合。',
    },
    limit: {
      type: 'number',
      required: false,
      description: '最大返回条数，默认 5',
    },
    minScore: {
      type: 'number',
      required: false,
      description: '最低相似度阈值（0-1），默认 0.4',
    },
  },
  examples: ['在本地 RAG 里搜索这段话题', '查一下群历史向量库里有没有相关内容', '搜索指定 collection 的知识'],
  triggerKeywords: ['rag', '向量搜索', '知识库搜索', '本地知识', '语义搜索'],
  whenToUse:
    '当你**说不准群里当时用的是哪个词**、只知道大概在讲什么时调用（如"之前有人讨论过 X 吗"）。知道确切的词就用 search_chat_history 搜正文，那个能给出时间和发言人且不漏；要看某个时间段的完整对话用 fetch_history_by_time。搜索的是原始聊天消息，不是 bot 的记忆摘要——要搜 bot 记住的结论请用 search_memory。',
})
@injectable()
export class RagSearchToolExecutor extends BaseToolExecutor {
  name = 'rag_search';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (!this.retrievalService.isRAGEnabled()) {
      return this.error('本地 RAG 未启用', 'rag_search requires enabled RAG');
    }

    const query = typeof call.parameters?.query === 'string' ? call.parameters.query.trim() : '';
    if (!query) {
      return this.error('请提供要搜索的内容', 'Missing required parameter: query');
    }

    const collection = this.resolveCollection(call, context);
    if (!collection) {
      return this.error('缺少 RAG collection，且当前上下文无法推断会话集合', 'rag_search could not resolve collection');
    }

    const limit =
      typeof call.parameters?.limit === 'number' && Number.isFinite(call.parameters.limit)
        ? Math.max(1, Math.floor(call.parameters.limit))
        : 5;
    const minScore =
      typeof call.parameters?.minScore === 'number' && Number.isFinite(call.parameters.minScore)
        ? call.parameters.minScore
        : 0.4;

    const hits = await this.retrievalService.vectorSearch(collection, query, {
      limit,
      minScore,
    });

    if (hits.length === 0) {
      return this.success('未找到相关本地 RAG 结果', {
        collection,
        query,
        results: [],
      });
    }

    const formatted = hits
      .map((hit, index) => {
        const content = typeof hit.content === 'string' ? hit.content : JSON.stringify(hit.payload ?? {});
        return `${index + 1}. score=${hit.score.toFixed(3)}\n${content}`;
      })
      .join('\n\n');

    return this.success(formatted, {
      collection,
      query,
      results: hits,
    });
  }

  private resolveCollection(call: ToolCall, context: ToolExecutionContext): string | null {
    const explicitCollection =
      typeof call.parameters?.collection === 'string' && call.parameters.collection.trim().length > 0
        ? call.parameters.collection.trim()
        : undefined;
    if (explicitCollection) {
      return explicitCollection;
    }

    const conversationId = context.conversationId;
    if (conversationId && conversationId.trim().length > 0) {
      return conversationId.trim();
    }

    const sessionId = context.metadata?.sessionId;
    const sessionType = context.metadata?.sessionType;
    if (typeof sessionId === 'string' && typeof sessionType === 'string') {
      return QdrantClient.getConversationHistoryCollectionName(sessionId, sessionType, context.groupId, context.userId);
    }

    if (context.groupId !== undefined) {
      return QdrantClient.getConversationHistoryCollectionName(
        `group:${context.groupId}`,
        'group',
        context.groupId,
        undefined,
      );
    }

    return QdrantClient.getConversationHistoryCollectionName(
      `user:${context.userId}`,
      'user',
      undefined,
      context.userId,
    );
  }
}
