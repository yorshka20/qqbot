// Search task executor - handles web search queries

import { inject, injectable } from 'tsyringe';
import { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { SearchResult } from '@/services/retrieval/searxng/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Queries accepted in one call. The ceiling is about keeping the result payload
 * readable, not about cost — the backend bills per query regardless of batching.
 */
const MAX_QUERIES_PER_CALL = 5;

/** Results kept per query. Enough to cross-check a fact without burying the turn. */
const MAX_RESULTS_PER_QUERY = 6;

/**
 * Search task executor.
 *
 * Visible in the reply scope as well as to subagents: routing every lookup
 * through `research` meant a reply could only reach the web by paying for a
 * subagent turn, so the model mostly answered from parametric memory instead.
 * `research` remains the right entry for multi-step investigation that would
 * otherwise flood the reply context; this is the cheap one-shot lookup.
 */
@Tool({
  name: 'search',
  description:
    '联网搜索。一次调用可并行提交多个查询（queries 数组），返回每个查询的结果摘要（标题、来源、日期、正文片段、链接）。多查询与单查询耗时相同，不必省着用。',
  executor: 'search',
  // Serper gives each attempt 10s and retries twice with backoff; a batch adds
  // headroom per extra query.
  timeoutMs: 40_000,
  visibility: {
    reply: { sources: ['qq-private', 'qq-group', 'discord'] },
    subagent: true,
  },
  // Looking something up must not cost the model the rounds it needs to act on
  // what it found, or it will skip the lookup to stay within budget.
  roundExempt: true,
  parameters: {
    queries: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: `搜索查询列表（1-${MAX_QUERIES_PER_CALL} 条）。相互独立的问题/实体/侧面请一次全部放进来并行查询——这和只查一条一样快。每条用检索关键词而非自然语言问句，专有名词用原文，时效性问题带上年份。`,
    },
  },
  examples: [
    '["2024 Nobel Physics winner"]',
    '["绝区零 1.5 版本 更新内容", "绝区零 1.5 新角色"]',
    '["Bun 2.0 release notes", "Bun 2.0 breaking changes"]',
  ],
  triggerKeywords: ['搜索', 'search', '查', '找', '查询', '了解'],
  whenToUse:
    '需要实时信息、新闻、具体数字/日期、版本号、或任何你不能百分之百确定的事实时调用。**倾向于多查一次而不是凭记忆作答**：你的知识有截止日期，搜索几乎不花时间，答错的代价远高于查一次。把问题拆成几个独立查询一次性提交。只有纯常识、纯闲聊、或问题只关于本群历史（用 search_memory）时才不需要。',
})
@injectable()
export class SearchToolExecutor extends BaseToolExecutor {
  name = 'search';

  constructor(@inject(RetrievalService) private retrievalService: RetrievalService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const queries = this.parseQueries(call.parameters?.queries);

    if (queries.length === 0) {
      return this.error('请提供至少一个搜索查询', 'Missing or empty required parameter: queries');
    }

    if (!this.retrievalService.isSearchEnabled()) {
      return this.error('联网搜索未启用', 'search is not enabled');
    }

    const accepted = queries.slice(0, MAX_QUERIES_PER_CALL);
    logger.info(`[SearchToolExecutor] Executing ${accepted.length} search(es): ${accepted.join(' | ')}`);

    let batches: SearchResult[][];
    try {
      batches = await this.retrievalService.searchBatch(accepted, { maxResults: MAX_RESULTS_PER_QUERY });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[SearchToolExecutor] Search failed for ${JSON.stringify(accepted)}: ${message}`);
      // Distinct from an empty result on purpose: the model must not turn a
      // broken backend into "there is nothing about this".
      return this.error(
        `联网搜索后端故障，本次查询没有执行：${message}。这不等于「没有搜到内容」，不要据此下结论。`,
        message,
      );
    }

    const total = batches.reduce((sum, results) => sum + results.length, 0);
    if (total === 0) {
      return this.success('搜索已执行，但没有匹配的结果。可以换个说法或换个语言再试一次。', {
        queries: accepted,
        results: [],
      });
    }

    logger.info(`[SearchToolExecutor] Search completed: ${total} results across ${accepted.length} quer(ies)`);

    return this.success(this.formatBatches(accepted, batches), {
      queries: accepted,
      results: batches.flat(),
      resultCount: total,
    });
  }

  /**
   * A single-query call is `[query]`, never a bare string — but models do emit a
   * bare string for a one-element array often enough that rejecting it would
   * just burn a round to re-ask.
   */
  private parseQueries(raw: unknown): string[] {
    const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (trimmed) seen.add(trimmed);
    }
    return [...seen];
  }

  /**
   * Keep each query's results under their own heading. Flattening them would
   * leave the model unable to tell which question a given snippet answered,
   * which is exactly the ambiguity multi-query search is meant to resolve.
   */
  private formatBatches(queries: string[], batches: SearchResult[][]): string {
    if (queries.length === 1) {
      return this.retrievalService.formatSearchResults(batches[0] ?? [], MAX_RESULTS_PER_QUERY);
    }

    return queries
      .map((query, index) => {
        const results = batches[index] ?? [];
        const body =
          results.length === 0
            ? '没有匹配的结果。'
            : this.retrievalService.formatSearchResults(results, MAX_RESULTS_PER_QUERY);
        return `### 查询：${query}\n\n${body}`;
      })
      .join('\n\n');
  }
}
