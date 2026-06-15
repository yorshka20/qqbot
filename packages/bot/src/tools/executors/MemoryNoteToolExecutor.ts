import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import type { MemoryExtractService } from '@/memory';
import { GROUP_MEMORY_USER_ID } from '@/memory/MemoryService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'memory_note',
  description:
    '当用户明确提出希望 bot 长期遵守的要求、规则或偏好时，调用此工具把它持久化到长期记忆。内容会被缓冲，并在下一次记忆整理时与其它记忆一起合并去重（不会立刻生效）。仅用于"长期、可复用"的诉求；一次性的请求不要记。',
  executor: 'memory_note',
  visibility: {
    reply: { sources: ['qq-group', 'discord', 'avatar-cmd'] },
    subagent: true,
  },
  parameters: {
    content: {
      type: 'string',
      required: true,
      description: '要长期记住的要求/规则/偏好，用第三人称清晰表述（例如"希望 bot 回复时不要使用 emoji"）。',
    },
    target: {
      type: 'string',
      required: false,
      enum: ['user', 'group'],
      description:
        'user=关于当前用户的个人要求/偏好（默认）；group=适用于整个群的规则/bot 行为设定（如群公告、群级行为规则）。',
    },
    scope: {
      type: 'string',
      required: false,
      description:
        '可选记忆 scope。user 记忆常用 instruction/preference/identity 等；group 记忆常用 rule。省略时由整理阶段自动归类。',
    },
  },
  examples: ['用户说以后都用中文回复 → 记为该用户的 instruction', '群主要求群里禁止刷屏 → 记为 group 的 rule'],
  triggerKeywords: ['记住', '以后', '要求', '规则', 'remember'],
  whenToUse: '当用户表达了希望 bot 长期遵守的规则/要求/偏好，需要跨对话持久化时调用。',
})
@injectable()
export class MemoryNoteToolExecutor extends BaseToolExecutor {
  name = 'memory_note';

  constructor(@inject(DITokens.MEMORY_EXTRACT_SERVICE) private memoryExtractService: MemoryExtractService) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId?.toString();
    if (!groupId) {
      return this.error('只有群聊场景下才能记录长期记忆', 'requires group context');
    }

    const content = typeof call.parameters?.content === 'string' ? call.parameters.content.trim() : '';
    if (!content) {
      return this.error('记忆内容不能为空', 'empty content');
    }

    const target = call.parameters?.target === 'group' ? 'group' : 'user';
    const scopeParam = call.parameters?.scope;
    const scope = typeof scopeParam === 'string' && scopeParam.trim().length > 0 ? scopeParam.trim() : undefined;
    const userId = target === 'group' ? GROUP_MEMORY_USER_ID : context.userId.toString();

    const saved = await this.memoryExtractService.addNote(groupId, userId, content, scope);
    if (!saved) {
      return this.error('记忆服务暂不可用，未能保存', 'note buffer unavailable');
    }

    return this.success(`已记下，将在下次记忆整理时合并：${content}`, { groupId, target, scope, content });
  }
}
