// Research meta-tool executor — delegates data-intensive tools to a subagent
// with isolated context, returning only the summarized conclusion to the main agent.

import { inject, injectable } from 'tsyringe';
import type { SubAgentManager } from '@/agent/SubAgentManager';
import { SubAgentType } from '@/agent/types';
import { DITokens } from '@/core/DITokens';
import type { RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Default timeout for research subagent (60 seconds) */
const RESEARCH_TIMEOUT = 90000;

/** URL extraction regex (HTTP/HTTPS only). Trailing punctuation stripped after match. */
const URL_REGEX = /https?:\/\/[^\s　<>"]+/g;

/** Max chars to return on the quick path. ~800 tokens keeps the main reply context lean. */
const QUICK_PATH_MAX_CHARS = 2500;

function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  // Strip trailing punctuation that commonly clings to URLs in Chinese/English text.
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;!?。，；！？)\]]+$/, '').trim())));
}

/**
 * Detect a "trivial single-URL fetch" task — exactly one URL in the prompt.
 * Purely structural signal (no keyword inference). Multi-URL or zero-URL tasks
 * fall through to the full subagent path. Recursion safety doesn't depend on
 * this routing: subagent already can't spawn another subagent (research is not
 * visible in subagent scope, and `spawn_subagent` is in `restrictedTools`).
 */
function detectQuickPathUrl(task: string): string | null {
  const urls = extractUrls(task);
  return urls.length === 1 ? urls[0] : null;
}

/**
 * Research tool executor.
 *
 * This is a **meta-tool**: it does not fetch data itself but spawns a
 * research subagent that has access to data-intensive tools (search,
 * fetch_page, rag_search, search_memory, fetch_history_by_time).
 *
 * The subagent runs in an isolated LLM context so that raw tool results
 * never enter the main reply context — only the condensed conclusion does.
 * This prevents prompt-token inflation that triggers provider TPM limits.
 */
@Tool({
  name: 'research',
  description:
    '调研工具：唯一的"读取外部信息"入口。需要联网搜索、抓取任何 URL 的网页正文、查询知识库或记忆时，都通过本工具发起。底层会自动选择 fetch_page / search / rag_search / search_memory 等工具，并把过程折叠为精炼结论返回。对单 URL 抓取场景会走快路径直接抓取，不再发起额外 LLM 推理。',
  executor: 'research',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
  parameters: {
    task: {
      type: 'string',
      required: true,
      description:
        '调研任务描述：需要查找的信息或要回答的问题。如果是单 URL 抓取，直接写"抓取 <URL>"或"读取这个网页 <URL> 的内容"即可。',
    },
  },
  examples: [
    '抓取这个链接的内容 https://example.com/article',
    '帮我查一下2024年诺贝尔物理学奖得主及其研究内容',
    '搜索并总结这篇文章的要点 https://example.com/article',
    '查找群里关于项目截止日期的讨论记录',
  ],
  triggerKeywords: ['搜索', 'search', '查', '找', '调研', '了解', '查询', '搜一下', '抓取', 'fetch', '网页', 'URL'],
  whenToUse:
    '凡是需要读取外部 URL 内容、联网搜索、查询知识库 / 记忆，必须用本工具——禁止用 execute_code 自己 fetch URL。一次调研可完成多步信息收集（先搜索再抓页面），避免多轮工具调用膨胀上下文。**任务描述要聚焦单一主题/单一问题**：宽泛或多子主题的需求请拆开多次调用（如不要把 "TC39 + 浏览器 API + CSS + React 路线图" 塞进一个 task），否则 subagent 会按"每个子话题 ≥2 来源验证"展开导致工具调用爆炸。视频站 URL（YouTube / B站 / Vimeo / TikTok 等）默认不主动抓取，除非用户明确要求读取该视频内容；图片 URL 不受此限。',
})
@injectable()
export class ResearchToolExecutor extends BaseToolExecutor {
  name = 'research';

  constructor(
    @inject(DITokens.SUB_AGENT_MANAGER)
    private subAgentManager: SubAgentManager,
    @inject(DITokens.RETRIEVAL_SERVICE)
    private retrievalService: RetrievalService,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const task = call.parameters?.task as string | undefined;

    if (!task) {
      return this.error('请提供调研任务描述', 'Missing required parameter: task');
    }

    // Quick path: trivial single-URL fetch. Skip the subagent LLM's "decide which tool"
    // round and call PageContentFetchService directly. The subagent LLM only existed to
    // pick the right tool — for a bare "fetch this URL" task that decision is foregone.
    const quickPathUrl = detectQuickPathUrl(task);
    if (quickPathUrl) {
      const quickResult = await this.tryQuickFetch(quickPathUrl, task);
      if (quickResult) return quickResult;
      // Fetch failed — fall through to subagent so it can try search / alternative sources.
      logger.info(`[ResearchToolExecutor] Quick-path fetch returned empty for ${quickPathUrl}, escalating to subagent`);
    }

    logger.info(
      `[ResearchToolExecutor] Starting research subagent | task=${JSON.stringify(task)} | params=${JSON.stringify(call.parameters)} | userId=${context.userId} | groupId=${context.groupId}`,
    );

    try {
      const parentContext = {
        userId: context.userId,
        groupId: context.groupId,
        messageType: context.messageType,
        conversationId: context.conversationId,
        messageId: context.messageId,
      };

      const sessionId = await this.subAgentManager.spawn(
        undefined, // no parent agent
        SubAgentType.RESEARCH,
        {
          description: task,
          input: { task },
          parentContext,
        },
        {
          timeout: RESEARCH_TIMEOUT,
          maxDepth: 1, // research subagent should not spawn further subagents
          maxChildren: 0,
          allowedTools: [], // empty = all subagent-scoped tools
          restrictedTools: ['spawn_subagent'], // no recursive spawning
          inheritSoul: false,
          inheritMemory: false,
          inheritPreference: false,
          providerName: ['deepseek', 'gemini'],
          // Pin to base models; main-flow defaults (deepseek-v4-pro / gemini paid 3.5-flash) are too costly here.
          providerModels: { deepseek: 'deepseek-v4-flash', gemini: 'gemini-3-flash-preview' },
          maxToolRounds: 4,
          maxTokens: 2000,
        },
      );

      await this.subAgentManager.execute(sessionId);
      const output = await this.subAgentManager.wait(sessionId, RESEARCH_TIMEOUT);

      const resultText = typeof output === 'string' ? output : JSON.stringify(output);

      logger.info(`[ResearchToolExecutor] Research completed (${resultText.length} chars): ${task}`);

      return this.success(resultText, {
        task,
        completed: true,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[ResearchToolExecutor] Research failed: ${errorMessage}`);
      return this.error(`调研失败: ${errorMessage}`, errorMessage);
    }
  }

  /**
   * Quick-path fetch for trivial single-URL tasks. Calls PageContentFetchService
   * directly (Jina Reader + Readability fallback) without spawning the subagent
   * LLM. Returns null on fetch failure so the caller can escalate.
   */
  private async tryQuickFetch(url: string, task: string): Promise<ToolResult | null> {
    const fetchService = this.retrievalService.getPageContentFetchService();
    if (!fetchService.isEnabled()) {
      logger.debug('[ResearchToolExecutor] Quick path skipped: page fetch disabled by config');
      return null;
    }

    logger.info(`[ResearchToolExecutor] Quick-path fetch | url=${url} | task=${JSON.stringify(task)}`);
    const startedAt = Date.now();
    const entries = await fetchService.fetchPages([{ url, title: url }]);
    const elapsed = Date.now() - startedAt;

    if (entries.length === 0 || !entries[0].text.trim()) {
      logger.warn(`[ResearchToolExecutor] Quick-path empty result | url=${url} | elapsed=${elapsed}ms`);
      return null;
    }

    const entry = entries[0];
    const truncated =
      entry.text.length > QUICK_PATH_MAX_CHARS
        ? `${entry.text.slice(0, QUICK_PATH_MAX_CHARS)}…\n\n（节选：完整长度 ${entry.text.length} 字符；如需完整内容请告知。）`
        : entry.text;

    logger.info(
      `[ResearchToolExecutor] Quick-path completed | url=${url} | rawChars=${entry.text.length} | returnedChars=${truncated.length} | elapsed=${elapsed}ms`,
    );
    return this.success(truncated);
  }
}
