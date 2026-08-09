import { injectable } from 'tsyringe';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'send_message',
  description:
    '立即向当前会话发送一条消息（不等待最终回复）。用于渐进式回复：先告知"我去查查"，或分多条发送阶段性结果。发出的内容就是正式发言，最终回复不必重复它；如果话已说完，最终回复保持简短即可。',
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
  examples: ['先发"稍等，我查一下赛程"再调用搜索工具', '任务执行中分步汇报进展'],
  whenToUse: '需要在完成最终回复之前先让会话里的人看到消息时调用；不要用它重复即将作为最终回复的内容。',
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
      return this.error(`本轮已发送 ${sent} 条消息，达到上限，请把剩余内容放进最终回复`, 'send limit reached');
    }

    try {
      // Target comes from the conversation context, never from LLM parameters —
      // this tool must not be able to send into arbitrary chats.
      const messageAPI = container.resolve<MessageAPI>(DITokens.MESSAGE_API);
      await messageAPI.sendFromContext(content, hookContext.message);
      hookContext.metadata.set('sendMessageCount', sent + 1);
      return this.success(`已发送（本轮第 ${sent + 1}/${maxSends} 条）`, { content });
    } catch (err) {
      logger.error('[SendMessageToolExecutor] send failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      return this.error(`发送失败：${msg}`, msg);
    }
  }
}
