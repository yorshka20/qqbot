// Search chat history by user ID - retrieves messages from a specific user in the current group

import { inject, injectable } from 'tsyringe';
import { type ConversationHistoryService, normalizeGroupId } from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { formatDateTimeShort } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

const MAX_RESULTS = 50;

@Tool({
  name: 'search_chat_history_by_user',
  description:
    '在当前群的聊天记录中按用户QQ号搜索。返回该用户发送的消息列表（内容、时间）。支持可选的时间范围限制。',
  executor: 'search_chat_history_by_user',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] }, reflection: true },
  parameters: {
    userId: {
      type: 'string',
      required: true,
      description: '要搜索的用户QQ号。',
    },
    timeRange: {
      type: 'string',
      required: false,
      description: '限制搜索的时间范围（从多久前开始）。格式: "-Xh"（X小时前）或 "-Xd"（X天前）。省略则搜索全部记录。',
    },
  },
  examples: [
    '搜索某个用户在群里说过的话',
    '查找QQ号123456最近的发言',
    '看看用户12345过去3天说了什么',
  ],
  triggerKeywords: ['用户发言', '某人说过', '谁说的', '发言记录', 'QQ号搜索'],
  whenToUse:
    '当需要查看特定用户在群聊中的发言历史时调用。适用于：查看某人最近说过什么、了解某用户的发言内容、回顾某人的讨论参与情况。',
})
@injectable()
export class SearchChatHistoryByUserToolExecutor extends BaseToolExecutor {
  name = 'search_chat_history_by_user';

  constructor(
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private conversationHistoryService: ConversationHistoryService,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId;
    if (!groupId) {
      if (context.metadata?.reflectionScope) {
        return this.success('（reflection 上下文：当前无活跃群上下文，无法搜索聊天记录）', {
          reflectionContext: true,
          reason: 'no-group',
          messageCount: 0,
          messages: [],
        });
      }
      return this.error('只有群聊场景下才能搜索聊天记录', 'search_chat_history_by_user requires group context');
    }

    const userId = call.parameters?.userId;
    if (typeof userId !== 'string' || !userId.trim()) {
      return this.error('请提供用户QQ号 (userId)', 'Missing required parameter: userId');
    }

    const trimmedUserId = userId.trim();

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

    const { sessionId } = normalizeGroupId(groupId);
    const results = await this.conversationHistoryService.searchMessagesByUserId(sessionId, 'group', trimmedUserId, {
      since: sinceTime,
      includeBot: false,
      limit: MAX_RESULTS,
    });

    logger.info(
      `[SearchChatHistoryByUser] userId="${trimmedUserId}" timeRange=${timeRange ?? 'none'} matched=${results.length}`,
    );

    if (results.length === 0) {
      return this.success(`没有找到用户「${trimmedUserId}」的消息`, {
        groupId,
        userId: trimmedUserId,
        messageCount: 0,
        messages: [],
      });
    }

    const messageSummary = results
      .map((msg) => {
        const time = formatDateTimeShort(msg.createdAt);
        return `[${time}] ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`;
      })
      .join('\n');

    const displayName = results[0].nickname ?? trimmedUserId;

    const reply = [
      `用户: ${displayName} (${trimmedUserId})`,
      `匹配消息: ${results.length}条${results.length >= MAX_RESULTS ? `（显示最近${MAX_RESULTS}条）` : ''}`,
      '',
      '=== 消息记录 ===',
      messageSummary,
    ].join('\n');

    return this.success(reply, {
      groupId,
      userId: trimmedUserId,
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
