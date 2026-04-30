// Search chat history by keyword - retrieves messages matching a keyword in the current group

import { inject, injectable } from 'tsyringe';
import { type ConversationHistoryService, normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { formatDateTimeShort } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** Maximum messages to return in results */
const MAX_RESULTS = 50;

@Tool({
  name: 'search_chat_history',
  description:
    '在当前群的聊天记录中按关键词搜索。返回包含关键词的消息列表（发送者、内容、时间）。支持可选的时间范围限制。',
  executor: 'search_chat_history',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] }, reflection: true },
  parameters: {
    keyword: {
      type: 'string',
      required: true,
      description: '搜索关键词。支持多个关键词用空格分隔（同时包含）。',
    },
    timeRange: {
      type: 'string',
      required: false,
      description: '限制搜索的时间范围（从多久前开始）。格式: "-Xh"（X小时前）或 "-Xd"（X天前）。省略则搜索全部记录。',
    },
    includeBot: {
      type: 'boolean',
      required: false,
      description: '是否包含 bot 自身的消息。默认 false。',
    },
  },
  examples: ['搜索群里关于"项目进度"的讨论', '查找最近聊天中提到"会议"的消息', '搜一下过去3天谁提到了"deadline"'],
  triggerKeywords: ['搜索聊天', '查找聊天', '搜索记录', '查找记录', '搜消息', '找消息'],
  whenToUse:
    '当需要在群聊历史中查找包含特定关键词的消息时调用。适用于：回忆谁说过某件事、查找特定话题的讨论、定位之前提到的信息。',
})
@injectable()
export class SearchChatHistoryToolExecutor extends BaseToolExecutor {
  name = 'search_chat_history';

  constructor(
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private conversationHistoryService: ConversationHistoryService,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId;
    if (!groupId) {
      if (Boolean(context.metadata?.reflectionScope)) {
        return this.success('（reflection 上下文：当前无活跃群上下文，无法搜索聊天记录）', {
          reflectionContext: true,
          reason: 'no-group',
          messageCount: 0,
          messages: [],
        });
      }
      return this.error('只有群聊场景下才能搜索聊天记录', 'search_chat_history requires group context');
    }

    const keyword = call.parameters?.keyword;
    if (typeof keyword !== 'string' || !keyword.trim()) {
      return this.error('请提供搜索关键词 (keyword)', 'Missing required parameter: keyword');
    }

    const keywords = keyword
      .trim()
      .split(/\s+/)
      .filter((k) => k.length > 0);
    if (keywords.length === 0) {
      return this.error('请提供有效的搜索关键词', 'Empty keyword after parsing');
    }

    const includeBot = call.parameters?.includeBot === true;

    // Determine time filter
    let sinceTime: Date | undefined;
    const timeRange = call.parameters?.timeRange;
    if (typeof timeRange === 'string' && timeRange.trim()) {
      sinceTime = this.parseTimeRange(timeRange.trim()) ?? undefined;
      if (!sinceTime) {
        return this.error(
          `无法解析时间范围: ${timeRange}。支持格式: "-Xh"（小时）, "-Xd"（天）`,
          `Invalid timeRange format: ${timeRange}`,
        );
      }
    }

    // Search using DB-level keyword matching
    const { sessionId } = normalizeGroupId(groupId);
    const results = await this.conversationHistoryService.searchMessagesByKeyword(sessionId, 'group', keywords, {
      since: sinceTime,
      includeBot,
      limit: MAX_RESULTS,
    });

    logger.info(`[SearchChatHistory] keyword="${keyword}" timeRange=${timeRange ?? 'none'} matched=${results.length}`);

    if (results.length === 0) {
      return this.success(`没有找到包含「${keyword}」的消息`, {
        groupId,
        keyword,
        messageCount: 0,
        messages: [],
      });
    }

    // Format output
    const messageSummary = results
      .map((msg) => {
        const time = formatDateTimeShort(msg.createdAt);
        const speaker = msg.isBotReply ? 'Bot' : (msg.nickname ?? String(msg.userId));
        return `[${time}] ${speaker}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`;
      })
      .join('\n');

    const reply = [
      `搜索关键词: ${keyword}`,
      `匹配消息: ${results.length}条${results.length >= MAX_RESULTS ? `（显示最近${MAX_RESULTS}条）` : ''}`,
      '',
      '=== 匹配消息 ===',
      messageSummary,
    ].join('\n');

    return this.success(reply, {
      groupId,
      keyword,
      messageCount: results.length,
      messages: results.map((m) => ({
        userId: m.userId,
        nickname: m.nickname,
        content: m.content,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
        isBotReply: m.isBotReply,
      })),
    });
  }

  /** Parse relative time range: "-Xh" (hours) or "-Xd" (days) */
  private parseTimeRange(input: string): Date | null {
    const match = input.match(/^-(\d+)(h|d)$/i);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const now = new Date();

    if (unit === 'h') {
      now.setTime(now.getTime() - value * 60 * 60 * 1000);
    } else if (unit === 'd') {
      now.setTime(now.getTime() - value * 24 * 60 * 60 * 1000);
    }

    return now;
  }
}
