import { injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'send_message',
  description:
    '在调用耗时工具之前，立即向当前会话发送一条先行提示（不等待最终回复）。目的是减少用户在等待最终回复期间的空白感——如果这条消息和最终回复几乎同时抵达，就完全失去意义。发出的内容是正式发言，最终回复不必重复它。',
  executor: 'send_message',
  visibility: {
    reply: { sources: ['qq-group', 'qq-private', 'discord'] },
  },
  parameters: {
    content: {
      type: 'string',
      required: true,
      description: '要发送的消息文本。',
    },
  },
  examples: [
    '先发"稍等，我查一下赛程"，然后再调用 research 工具',
    '用户要求分析一段视频，先发"这个视频我看看，稍等"，再调用 analyze_video',
  ],
  whenToUse:
    '仅在准备调用可能耗时的工具之前使用，例如 research、search、fetch_page、execute_code、spawn_subagent、generate_image、analyze_video 等；或在预计要生成一段很长回复之前使用。如果你已经拿到全部信息、这一轮就要输出最终回复了，就不要调用它——那样只会和最终回复同时到达，对用户体验没有帮助，反而多一条冗余消息。',
})
@injectable()
export class SendMessageToolExecutor extends BaseToolExecutor {
  name = 'send_message';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const content = typeof call.parameters?.content === 'string' ? call.parameters.content.trim() : '';
    if (!content) {
      return this.error('消息内容不能为空', 'empty content');
    }

    const hookContext = context.hookContext;
    if (!hookContext) {
      return this.error('缺少会话上下文，无法发送', 'missing hook context');
    }

    const container = getContainer();
    const config = container.resolve<Config>(DITokens.CONFIG);
    const maxSends = config.getAgendaLlmLimits().maxSendsPerRun;
    const sent = hookContext.metadata.get('sendMessageCount') ?? 0;
    if (sent >= maxSends) {
      return this.error(
        `send_message 已达本次回复的发送上限（${maxSends} 条）。剩余内容请直接输出为最终回复文本（会被发送），或调用 end_turn 结束本次回复`,
        'send limit reached',
      );
    }

    try {
      // Target comes from the conversation context, never from LLM parameters —
      // this tool must not be able to send into arbitrary chats.
      const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
      const sendResult = await messageAPI.sendFromContext(content, hookContext.message);
      hookContext.metadata.set('sendMessageCount', sent + 1);
      await this.persistSentMessage(hookContext, content, sendResult.message_seq);
      return this.success(
        `已发送（这是你本次回复中通过 send_message 发出的第 ${sent + 1} 条，上限 ${maxSends} 条；该额度只计 send_message，卡片与最终文本回复不占用）`,
        { content },
      );
    } catch (err) {
      logger.error('[SendMessageToolExecutor] send failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      return this.error(`发送失败：${msg}`, msg);
    }
  }

  /**
   * Persist the sent message into session history. This send bypasses
   * SendSystem/onMessageSent, so without an explicit write the conversation
   * history would omit it and the next turn's LLM would see its own delivered
   * messages missing. Failure is non-fatal — the message already reached the
   * user; history is best-effort (appendBotMessageToSession catches internally).
   */
  private async persistSentMessage(hookContext: HookContext, content: string, messageSeq?: number): Promise<void> {
    const message = hookContext.message;
    const isGroup = message.messageType === 'group';
    const targetId = isGroup ? message.groupId : message.userId;
    if (targetId == null) return;
    const historyService = getContainer().resolve<ConversationHistoryService>(DITokens.CONVERSATION_HISTORY_SERVICE);
    const botSelfId = Number(hookContext.metadata.get('botSelfId'));
    await historyService.appendBotMessageToSession(
      { sessionType: isGroup ? 'group' : 'user', targetId },
      content,
      message.protocol,
      {
        botUserId: Number.isNaN(botSelfId) ? 0 : botSelfId,
        messageSeq,
        viaTool: 'send_message',
      },
    );
  }
}
