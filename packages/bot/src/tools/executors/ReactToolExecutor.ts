// ReactToolExecutor — lets the LLM put a QQ reaction on the message it is answering.

import { injectable } from 'tsyringe';
import { getContainer } from '@/core/DIContainer';
import { PluginManager } from '@/plugins/PluginManager';
import { ReactionPlugin } from '@/plugins/plugins/ReactionPlugin';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'react',
  description:
    '给当前这条群消息贴一个 QQ 表情回应（就是群里长按消息贴表情那个功能）。这是"说话"和"沉默"之间的第三档：某条消息值得表个态，但不值得专门回一句话时用它。贴完如果没有别的要说，直接 end_turn。',
  executor: 'react',
  visibility: {
    reply: { sources: ['qq-group'] },
  },
  parameters: {
    face: {
      type: 'string',
      required: true,
      description:
        '表情名字（如 笑哭 / 头秃 / 暗中观察），取值范围与回复正文里 [表情:名字] 的词表相同；也可以直接给一个 emoji 字符。',
    },
  },
  examples: ['群友讲了个好笑的事，不需要接话 → face=笑哭 然后 end_turn', '有人吐槽加班，想表示共情 → face=头秃'],
  whenToUse:
    '当前消息值得一个轻量表态、但接一句话反而打断群聊节奏时。每个群有冷却时间，被限流会在返回里说明——那就是"这次别贴了"，不要改用文字硬凑一句。',
})
@injectable()
export class ReactToolExecutor extends BaseToolExecutor {
  name = 'react';

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const face = typeof call.parameters?.face === 'string' ? call.parameters.face.trim() : '';
    if (!face) {
      return this.error('face 不能为空', 'empty face');
    }

    const message = context.hookContext?.message;
    if (!message?.groupId) {
      return this.error('只能在群聊里贴表情', 'not a group message');
    }

    const plugin = getContainer().resolve(PluginManager).getPluginAs<ReactionPlugin>('reaction');
    if (!plugin) {
      return this.error('表情回应功能未启用', 'reaction plugin not registered');
    }

    const messageSeq = ReactionPlugin.messageSeqOf(message);
    if (!messageSeq) {
      return this.error('当前协议无法定位这条消息，贴不了表情', 'no messageSeq');
    }

    const outcome = await plugin.react({ groupId: message.groupId, messageSeq, face });
    if (!outcome.ok) {
      // Surfaced as a successful call carrying a refusal: the model needs to read the reason
      // and move on, not treat it as a broken tool and retry.
      return this.success(`没贴成：${outcome.reason}`, { reacted: false, reason: outcome.reason });
    }

    return this.success(`已贴上「${outcome.label}」。`, { reacted: true, face: outcome.label, faceId: outcome.faceId });
  }
}
