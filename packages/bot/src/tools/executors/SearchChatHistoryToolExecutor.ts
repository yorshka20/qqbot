// Search this conversation's messages by content keyword, by sender, or by both.
//
// One tool rather than a keyword/by-user pair: they read the same table, return the
// same shape, and differ only in which WHERE clause they add. Split apart, the model
// had to route every lookup between them and got it wrong whenever it held a nickname
// instead of a QQ number — falling back to a keyword search on the name, which matches
// message bodies and returns everyone talking *about* that person. Combined, the two
// filters also compose: "what did X say about Y" was previously unexpressible.

import { inject, injectable } from 'tsyringe';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { formatDateTimeShort } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { resolveConversationScope } from './conversationScope';
import { resolveSender, SENDER_PARAM_DESCRIPTIONS } from './senderResolution';

/** Maximum messages to return in results */
const MAX_RESULTS = 50;

@Tool({
  name: 'search_chat_history',
  description:
    '取当前会话的聊天记录原文。可以按 keyword（正文里出现过的字面词）筛，按 userId / nickname（谁发的）筛，或者两者同时用来查“某人说过关于某事的什么”。至少给一个筛选条件。返回时间、发言人和正文。',
  executor: 'search_chat_history',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] }, reflection: true },
  parameters: {
    keyword: {
      type: 'string',
      required: false,
      description:
        '要在消息正文里查找的字面词，原样做子串匹配，所以填话题词本身而不是一整句问题。空格分隔多个词表示同时包含。不要拿它填人名——那只会搜到别人提到 TA 的消息；查某人的发言请用 userId 或 nickname。',
    },
    userId: {
      type: 'string',
      required: false,
      description: `按发言人筛选。${SENDER_PARAM_DESCRIPTIONS.userId}`,
    },
    nickname: {
      type: 'string',
      required: false,
      description: `按发言人筛选。${SENDER_PARAM_DESCRIPTIONS.nickname}`,
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
  examples: ['{"keyword":"项目进度"}', '{"nickname":"某某"}', '{"userId":"123456","keyword":"显卡","timeRange":"-7d"}'],
  triggerKeywords: ['搜索聊天', '查找聊天', '搜索记录', '查找记录', '搜消息', '找消息', '某人说过', '谁说的'],
  whenToUse:
    '当你要的是**具体某几条原始消息**时调用——某个话题被谁提起过、某个人说过什么、某人对某事的说法。想看某个时间段里的完整对话用 fetch_history_by_time；只需要「关于这个群/这个人已经沉淀下来的结论」而不是原话，用 get_memory。',
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
    const scope = resolveConversationScope(context);
    if (!scope) {
      if (context.metadata?.reflectionScope) {
        return this.success('（reflection 上下文：当前无活跃会话，无法搜索聊天记录）', {
          reflectionContext: true,
          reason: 'no-conversation',
          messageCount: 0,
          messages: [],
        });
      }
      return this.error('当前没有可搜索的会话', 'search_chat_history requires a conversation context');
    }

    const keywords = this.parseKeywords(call.parameters?.keyword);
    const resolution = await resolveSender(this.conversationHistoryService, scope, call.parameters ?? {});
    if (resolution.kind === 'not_found') {
      return this.success(resolution.message, { nickname: resolution.nickname, messageCount: 0, messages: [] });
    }
    if (resolution.kind === 'ambiguous') {
      return this.success(resolution.message, { nickname: resolution.nickname, candidates: resolution.candidates });
    }
    const sender = resolution.kind === 'resolved' ? resolution : null;

    if (keywords.length === 0 && !sender) {
      return this.error(
        '请至少给一个筛选条件：keyword（正文关键词）或 userId / nickname（发言人）',
        'search_chat_history requires keyword, userId or nickname',
      );
    }

    const timeRange = call.parameters?.timeRange;
    let sinceTime: Date | undefined;
    if (typeof timeRange === 'string' && timeRange.trim()) {
      sinceTime = this.parseTimeRange(timeRange.trim()) ?? undefined;
      if (!sinceTime) {
        return this.error(
          `无法解析时间范围: ${timeRange}。支持格式: "-Xh"（小时）, "-Xd"（天）`,
          `Invalid timeRange format: ${timeRange}`,
        );
      }
    }

    const results = await this.conversationHistoryService.searchMessages(scope.sessionId, scope.sessionType, {
      keywords: keywords.length > 0 ? keywords : undefined,
      userId: sender?.userId,
      since: sinceTime,
      includeBot: call.parameters?.includeBot === true,
      limit: MAX_RESULTS,
    });

    const criteria = this.describeCriteria(keywords, sender);
    logger.info(
      `[SearchChatHistory] session=${scope.sessionId} ${criteria} timeRange=${timeRange ?? 'none'} matched=${results.length}`,
    );

    if (results.length === 0) {
      return this.success(`没有找到${criteria}的消息`, {
        sessionId: scope.sessionId,
        groupId: scope.groupId,
        messageCount: 0,
        messages: [],
      });
    }

    const messageSummary = results
      .map((msg) => {
        const time = formatDateTimeShort(msg.createdAt);
        const speaker = msg.isBotReply ? 'Bot' : (msg.nickname ?? String(msg.userId));
        return `[${time}] ${speaker}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`;
      })
      .join('\n');

    const reply = [
      `筛选条件: ${criteria}`,
      `匹配消息: ${results.length}条${results.length >= MAX_RESULTS ? `（显示最近${MAX_RESULTS}条）` : ''}`,
      '',
      '=== 匹配消息 ===',
      messageSummary,
    ].join('\n');

    return this.success(reply, {
      sessionId: scope.sessionId,
      groupId: scope.groupId,
      keywords,
      userId: sender?.userId,
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

  private parseKeywords(raw: unknown): string[] {
    if (typeof raw !== 'string') {
      return [];
    }
    return raw.trim().split(/\s+/).filter(Boolean);
  }

  private describeCriteria(keywords: string[], sender: { label: string } | null): string {
    const parts: string[] = [];
    if (sender) {
      parts.push(`发言人「${sender.label}」`);
    }
    if (keywords.length > 0) {
      parts.push(`关键词「${keywords.join(' ')}」`);
    }
    return parts.join(' + ');
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
