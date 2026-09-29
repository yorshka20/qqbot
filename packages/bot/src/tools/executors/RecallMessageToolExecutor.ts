import { inject, injectable } from 'tsyringe';
import { MessageAPI } from '@/api/methods/MessageAPI';
import {
  ConversationHistoryService,
  type ConversationMessageEntry,
  normalizeSessionId,
} from '@/conversation/history/ConversationHistoryService';
import { formatTimeCompact } from '@/utils/dateTime';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/** How far back (all speakers) the bot's own messages are searched for the one to recall. */
export const RECALL_LOOKBACK_MESSAGES = 100;
/** Messages listed back to the model when its excerpt names none, or several. */
const LISTED_CANDIDATES = 5;
const LISTED_PREVIEW_CHARS = 40;

/** Only a message stored with its sequence number can be addressed for recall. */
type RecallableEntry = ConversationMessageEntry & { messageSeq: number };

@Tool({
  name: 'recall_message',
  description:
    '撤回你自己之前在当前会话里发出的一条消息（QQ 的"撤回"）。用 content 摘一段那条消息的原文来指定是哪一条。撤回后群里就看不到它了，历史里这条会带上 [已撤回] 标记。只能撤回你自己的消息；QQ 对撤回有时限，太久之前的消息会撤回失败，失败原因会在返回里说明。',
  executor: 'recall_message',
  visibility: {
    reply: { sources: ['qq-group', 'qq-private'] },
  },
  parameters: {
    content: {
      type: 'string',
      required: true,
      description:
        '要撤回的那条消息里的一段原文，照历史里你发出的内容原样摘录，十几个字足够。能唯一定位到一条消息即可，不必整条照抄。',
    },
  },
  examples: [
    '群友说"刚才那条撤了吧"，指的是你上一条"明天大概率下雨" → content="明天大概率下雨"',
    '你发现自己刚发的消息把数字写错了 → 撤回那条，再发一条正确的',
  ],
  whenToUse:
    '有人要求你撤回某条消息，或你发现自己刚发出的内容有误、不该发时。一次撤回一条；要撤回多条就调用多次，每次摘不同的原文。',
})
@injectable()
export class RecallMessageToolExecutor extends BaseToolExecutor {
  name = 'recall_message';

  constructor(
    @inject(ConversationHistoryService) private readonly historyService: ConversationHistoryService,
    @inject(MessageAPI) private readonly messageAPI: MessageAPI,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const content = typeof call.parameters?.content === 'string' ? call.parameters.content.trim() : '';
    if (!content) {
      return this.error('content 不能为空：请摘一段要撤回的那条消息的原文', 'empty content');
    }

    const hookContext = context.hookContext;
    if (!hookContext) {
      return this.error('缺少会话上下文，无法撤回', 'missing hook context');
    }
    const message = hookContext.message;
    // Milky addresses a message by its sequence number, which is what history stores.
    if (message.protocol !== 'milky') {
      return this.error('当前协议无法定位历史消息，撤回不了', `unsupported protocol ${message.protocol}`);
    }

    const sessionType = message.messageType === 'group' ? 'group' : 'user';
    const sessionId = normalizeSessionId(
      hookContext.metadata.get('sessionId'),
      sessionType,
      message.groupId,
      message.userId,
    );
    const history = await this.historyService.getRecentMessagesForSession(
      sessionId,
      sessionType,
      RECALL_LOOKBACK_MESSAGES,
    );
    const candidates = history.filter(
      (entry): entry is RecallableEntry => entry.isBotReply && entry.messageSeq != null && !entry.recalled,
    );
    if (candidates.length === 0) {
      return this.error('最近没有你发出、还能撤回的消息', 'no candidates');
    }

    const needle = squash(content);
    const matches = candidates.filter((entry) => squash(entry.content).includes(needle));
    if (matches.length === 0) {
      return this.error(
        `没找到包含「${content}」的、你自己发的消息。你最近发的是：\n${listEntries(candidates)}`,
        'no match',
      );
    }
    if (matches.length > 1) {
      return this.error(
        `有 ${matches.length} 条你发的消息都包含「${content}」，请摘一段更长、更独特的原文：\n${listEntries(matches)}`,
        'ambiguous',
      );
    }

    const target = matches[0];
    const messageSeq = target.messageSeq;
    try {
      await this.messageAPI.recallFromContext(messageSeq, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[RecallMessageToolExecutor] Recall failed | session=${sessionId} | messageSeq=${messageSeq}:`, err);
      return this.error(`撤回失败：${reason}`, reason);
    }

    logger.info(`[RecallMessageToolExecutor] Recalled | session=${sessionId} | messageSeq=${messageSeq}`);
    return this.success(`已撤回你在 ${formatTimeCompact(target.createdAt)} 发的「${preview(target.content)}」。`, {
      messageSeq,
    });
  }
}

/** Whitespace-insensitive form for matching: the model's excerpt rarely keeps line breaks intact. */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > LISTED_PREVIEW_CHARS ? `${oneLine.slice(0, LISTED_PREVIEW_CHARS)}…` : oneLine;
}

function listEntries(entries: ConversationMessageEntry[]): string {
  return entries
    .slice(-LISTED_CANDIDATES)
    .map((entry) => `- ${formatTimeCompact(entry.createdAt)}「${preview(entry.content)}」`)
    .join('\n');
}
