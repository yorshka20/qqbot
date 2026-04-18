// WechatSearchToolExecutor - searches WeChat messages and articles
// Used by Agenda or user queries to find relevant content

import { inject, injectable } from 'tsyringe';
import { WechatDITokens } from '@/services/wechat/tokens';
import type { WechatDigestService } from '@/services/wechat/WechatDigestService';
import { Tool } from '@/tools/decorators';
import { BaseToolExecutor } from '@/tools/executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';

/**
 * WechatSearchToolExecutor
 *
 * Searches WeChat messages and articles by keyword. Supports filtering
 * by content type and time range.
 *
 * Usage in schedule.md:
 * ```markdown
 * ## 微信内容查询
 * - 触发: `onEvent wechat:message`
 * - 群: `123456789`
 *
 * 如果用户消息包含"查找微信"或"搜索微信"，调用 wechat_search 搜索相关内容。
 * ```
 */
@Tool({
  name: 'wechat_search',
  description: '搜索微信消息和文章。在聊天记录和收藏的文章中查找包含关键词的内容。',
  executor: 'wechat_search',
  visibility: ['subagent'],
  parameters: {
    keyword: {
      type: 'string',
      required: true,
      description: '搜索关键词。',
    },
    searchIn: {
      type: 'string',
      required: false,
      description: '搜索范围：messages(仅消息)、articles(仅文章)、all(全部)。默认 all。',
    },
    isGroup: {
      type: 'boolean',
      required: false,
      description: '是否只搜索群聊消息。仅当 searchIn 包含 messages 时有效。',
    },
    sinceHours: {
      type: 'number',
      required: false,
      description: '搜索过去多少小时的内容。不指定则搜索全部。',
    },
    limit: {
      type: 'number',
      required: false,
      description: '最多返回多少条结果。默认50条。',
    },
  },
  examples: ['搜索微信中关于会议的消息', '查找微信收到的AI相关文章', '在微信群聊中搜索项目进度'],
  whenToUse: '当需要在微信历史消息或文章中查找特定内容时使用。',
})
@injectable()
export class WechatSearchToolExecutor extends BaseToolExecutor {
  name = 'wechat_search';

  constructor(@inject(WechatDITokens.DIGEST_SERVICE) private digestService: WechatDigestService) {
    super();
  }

  async execute(call: ToolCall, _context: ToolExecutionContext): Promise<ToolResult> {
    const keyword = call.parameters?.keyword as string | undefined;

    if (!keyword) {
      return this.error('请提供搜索关键词', 'Missing required parameter: keyword');
    }

    const searchIn = call.parameters?.searchIn as 'messages' | 'articles' | 'all' | undefined;
    const isGroup = call.parameters?.isGroup as boolean | undefined;
    const sinceHours = call.parameters?.sinceHours as number | undefined;
    const limit = call.parameters?.limit as number | undefined;

    // Calculate since timestamp
    let sinceTs: number | undefined;
    if (sinceHours && sinceHours > 0) {
      sinceTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    }

    logger.info(
      `[WechatSearchToolExecutor] Searching | keyword="${keyword}" ` +
        `searchIn=${searchIn ?? 'all'} isGroup=${isGroup ?? 'any'} sinceHours=${sinceHours ?? 'all'}`,
    );

    try {
      const results = this.digestService.search(keyword, {
        sinceTs,
        searchIn: searchIn ?? 'all',
        isGroup,
        limit: limit ?? 50,
      });

      if (results.length === 0) {
        return this.success(`未找到与 "${keyword}" 相关的内容。`, {
          keyword,
          resultCount: 0,
          results: [],
        });
      }

      const text = this.digestService.searchText(keyword, {
        sinceTs,
        searchIn: searchIn ?? 'all',
        isGroup,
        limit: limit ?? 50,
      });

      logger.info(`[WechatSearchToolExecutor] Found ${results.length} results for "${keyword}"`);

      return this.success(text, {
        keyword,
        resultCount: results.length,
        results: results.map((r) => ({
          type: r.type,
          content: r.content,
          source: r.source,
          url: r.url,
          time: r.time,
        })),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('[WechatSearchToolExecutor] Error:', err);
      return this.error('搜索失败', errorMsg);
    }
  }
}
