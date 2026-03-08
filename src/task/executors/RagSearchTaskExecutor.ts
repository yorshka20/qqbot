// RAG search task executor - retrieves local vector-store results for the current conversation or a named collection

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { QdrantClient, type RetrievalService } from '@/services/retrieval';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

@TaskDefinition({
  name: 'rag_search',
  description: 'Search the local RAG/vector store for relevant context',
  executor: 'rag_search',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Semantic search query for the local vector store.',
    },
    collection: {
      type: 'string',
      required: false,
      description: 'Optional explicit collection name. Omit to search the current conversation-history collection.',
    },
    limit: {
      type: 'number',
      required: false,
      description: 'Maximum number of results to return. Default 5.',
    },
    minScore: {
      type: 'number',
      required: false,
      description: 'Minimum score threshold. Default 0.4.',
    },
  },
  examples: ['在本地 RAG 里搜索这段话题', '查一下群历史向量库里有没有相关内容', '搜索指定 collection 的知识'],
  triggerKeywords: ['rag', '向量搜索', '知识库搜索', '本地知识', '语义搜索'],
  whenToUse:
    'Use when you need local vector-retrieved context from the app’s RAG store, such as conversation-history retrieval or a named local collection.',
})
@injectable()
export class RagSearchTaskExecutor extends BaseTaskExecutor {
  name = 'rag_search';

  constructor(@inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService) {
    super();
  }

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    if (!this.retrievalService.isRAGEnabled()) {
      return this.error('本地 RAG 未启用', 'rag_search requires enabled RAG');
    }

    const query = typeof task.parameters?.query === 'string' ? task.parameters.query.trim() : '';
    if (!query) {
      return this.error('请提供要搜索的内容', 'Missing required parameter: query');
    }

    const collection = this.resolveCollection(task, context);
    if (!collection) {
      return this.error('缺少 RAG collection，且当前上下文无法推断会话集合', 'rag_search could not resolve collection');
    }

    const limit =
      typeof task.parameters?.limit === 'number' && Number.isFinite(task.parameters.limit)
        ? Math.max(1, Math.floor(task.parameters.limit))
        : 5;
    const minScore =
      typeof task.parameters?.minScore === 'number' && Number.isFinite(task.parameters.minScore)
        ? task.parameters.minScore
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

  private resolveCollection(task: Task, context: TaskExecutionContext): string | null {
    const explicitCollection =
      typeof task.parameters?.collection === 'string' && task.parameters.collection.trim().length > 0
        ? task.parameters.collection.trim()
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
