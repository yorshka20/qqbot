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
