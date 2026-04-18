// WeChat moments topic analysis — retrieves relevant moments then calls LLMService for deep analysis

import { inject, injectable } from 'tsyringe';
import type { LLMService } from '@/ai/services/LLMService';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { loadAnalysisPrompt } from '@/services/wechat/moments/momentsTags';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

const COLLECTION = 'wechat_moments';
const DEFAULT_LIMIT = 15;
const DEFAULT_MIN_SCORE = 0.3;

/** Allowed providers for moments analysis (cost-controlled). */
const ALLOWED_PROVIDERS = ['ollama', 'deepseek', 'doubao'] as const;

@Tool({
  name: 'wechat_moments_analyze',
  description:
    '对用户朋友圈中某个话题进行深度分析。' +
    '检索相关朋友圈内容，调用 LLM 进行纵向分析：识别核心立场、思想演变轨迹、关键转折点，并引用原文佐证。' +
    '注意：本工具会调用 LLM 进行分析，响应时间较长，请在调用前告知用户正在分析中。',
  executor: 'wechat_moments_analyze',
  parameters: {
    topic: {
      type: 'string',
      required: true,
      description: '要分析的话题（如"对AI的看法"、"职业发展"、"创业"）',
    },
    searchQueries: {
      type: 'string',
      required: false,
      description: '自定义搜索词，用 | 分隔（如"创业|商业化|赚钱"），不填则自动用 topic 作为搜索词',
    },
    analysisAngle: {
      type: 'string',
      required: false,
      description: '分析角度提示（如"重点关注立场转变"、"对比早期和近期的态度差异"），会追加到 LLM prompt 中',
    },
    limit: {
      type: 'number',
      required: false,
      description: `检索条数，默认 ${DEFAULT_LIMIT}`,
    },
  },
  visibility: ['subagent'],
  examples: [
    '分析我朋友圈里对AI行业的看法变化',
    '帮我梳理一下我对工作这件事的思考脉络',
    '我在音乐品味上有什么变化趋势',
  ],
  whenToUse:
    '当用户想要深度了解自己在某个话题上的思想变迁时使用。' +
    '与 wechat_moments_search（纯检索）不同，本工具会额外调用 LLM 进行分析并输出结构化的洞察。' +
    '适合回答「我的看法是怎么变的」「帮我梳理一下」「分析我在XX方面的思路」这类需要综合分析的问题。',
})
@injectable()
export class WechatMomentsAnalyzeToolExecutor extends BaseToolExecutor {
  name = 'wechat_moments_analyze';

  constructor(
    @inject(DITokens.RETRIEVAL_SERVICE) private retrievalService: RetrievalService,
    @inject(DITokens.LLM_SERVICE) private llmService: LLMService,
  ) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    if (!this.retrievalService.isRAGEnabled()) {
      return this.error('RAG 未启用，无法分析朋友圈', 'RAG is not enabled');
    }

    const topic = typeof call.parameters?.topic === 'string' ? call.parameters.topic.trim() : '';
    if (!topic) {
      return this.error('请提供要分析的话题', 'Missing required parameter: topic');
    }

    const limit =
      typeof call.parameters?.limit === 'number' && Number.isFinite(call.parameters.limit)
        ? Math.max(1, Math.floor(call.parameters.limit))
        : DEFAULT_LIMIT;

    const analysisAngle =
      typeof call.parameters?.analysisAngle === 'string' ? call.parameters.analysisAngle.trim() : '';

    // Build search queries
    const searchQueriesRaw =
      typeof call.parameters?.searchQueries === 'string' ? call.parameters.searchQueries.trim() : '';
    const extraQueries = searchQueriesRaw
      ? searchQueriesRaw
          .split('|')
          .map((q) => q.trim())
          .filter(Boolean)
      : [];
    const allQueries = [topic, ...extraQueries];

    logger.info(`[WechatMomentsAnalyze] topic="${topic}" queries=[${allQueries.join(', ')}] limit=${limit}`);

    try {
      // Step 1: Retrieve relevant moments
      const hits = await this.retrievalService.vectorSearchMulti(COLLECTION, allQueries, {
        limitPerQuery: limit,
        maxTotal: limit,
        minScore: DEFAULT_MIN_SCORE,
      });

      if (hits.length < 2) {
        return this.success(`在朋友圈中未找到足够的相关内容来进行「${topic}」的分析（仅找到 ${hits.length} 条）。`, {
          topic,
          hitsCount: hits.length,
        });
      }

      // Sort by create_time ascending
      hits.sort((a, b) => {
        const ta = (a.payload?.create_time as string) || '';
        const tb = (b.payload?.create_time as string) || '';
        return ta.localeCompare(tb);
      });

      const times = hits
        .map((h) => (h.payload?.create_time as string) || '')
        .filter(Boolean)
        .sort();
      const earliest = times[0] || '未知';
      const latest = times[times.length - 1] || '未知';

      // Step 2: Build prompt from template
      const contextText = hits
        .map((hit) => {
          const ct = (hit.payload?.create_time as string) || '未知时间';
          const content = typeof hit.content === 'string' ? hit.content : '';
          return `[${ct}]\n${content}`;
        })
        .join('\n\n---\n\n');

      const prompt = loadAnalysisPrompt({ topic, analysisAngle, contextText });

      // Step 3: Call LLM via LLMService with provider fallback
      const analysis = await this.callLLM(prompt, topic);

      return this.success(
        `## 朋友圈话题分析：${topic}\n\n` +
          `> 基于 ${hits.length} 条相关内容（${earliest} ~ ${latest}）\n\n` +
          analysis,
        { topic, hitsCount: hits.length, timeRange: { earliest, latest } },
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatMomentsAnalyze] Error:', err);
      return this.error('分析朋友圈话题失败', errorMsg);
    }
  }

  /**
   * Call LLM via LLMService with provider fallback (ollama → deepseek → doubao).
   */
  private async callLLM(prompt: string, topic: string): Promise<string> {
    for (const providerName of ALLOWED_PROVIDERS) {
      try {
        const provider = await this.llmService.getAvailableProvider(providerName);
        if (!provider) continue;

        const response = await provider.generate(prompt, {
          temperature: 0.3,
          maxTokens: 2048,
        });

        const text = response.text?.trim();
        if (text) return text;

        logger.warn(`[WechatMomentsAnalyze] Empty response from "${providerName}" for "${topic}"`);
      } catch (err) {
        logger.warn(`[WechatMomentsAnalyze] Provider "${providerName}" failed for "${topic}":`, err);
      }
    }

    throw new Error(`All providers (${ALLOWED_PROVIDERS.join(', ')}) failed for topic "${topic}"`);
  }
}
