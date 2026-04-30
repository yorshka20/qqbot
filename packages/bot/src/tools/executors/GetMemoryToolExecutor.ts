// Get memory task executor - reads group/user memory slots for local tool use

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

@Tool({
  name: 'get_memory',
  description:
    '读取当前群或指定用户的本地长期记忆。返回 bot 过去提取并保存的关于该群/用户的关键信息（偏好、设定、历史事实等）。',
  executor: 'get_memory',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] }, subagent: true },
  parameters: {
    userId: {
      type: 'string',
      required: false,
      description: '目标用户 QQ 号。省略则读取群整体记忆；填写则读取该用户在本群的个人记忆。',
    },
    includeGroupMemory: {
      type: 'boolean',
      required: false,
      description: '为 true 时，在返回用户记忆的同时也返回群记忆。默认 false。',
    },
  },
  examples: ['读取当前群记忆', '查看这个用户在本群的记忆', '读取群里的长期记忆'],
  triggerKeywords: ['记忆', 'memory', '群记忆', '用户记忆'],
  whenToUse:
    '当需要回忆关于当前群或某用户的历史信息时调用（如"他之前说过什么"、"群里有什么规矩"）。这是 bot 本地记忆，不是联网搜索。',
})
@injectable()
export class GetMemoryToolExecutor extends BaseToolExecutor {
  name = 'get_memory';

  constructor(@inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService) {
    super();
  }

  execute(call: ToolCall, context: ToolExecutionContext): ToolResult {
    const groupId = context.groupId?.toString();
    if (!groupId) {
      return this.error('只有群聊场景下才能读取本地记忆', 'get_memory requires group context');
    }

    const userIdParam = call.parameters?.userId;
    const includeGroupMemory = call.parameters?.includeGroupMemory === true;
    const targetUserId =
      typeof userIdParam === 'string' && userIdParam.trim().length > 0 ? userIdParam.trim() : undefined;

    const targetMemory = this.memoryService.getMemory(groupId, targetUserId);
    const parts: string[] = [];
    if (includeGroupMemory && targetUserId) {
      const groupMemory = this.memoryService.getMemory(groupId);
      if (groupMemory.content) {
        parts.push(`群记忆:\n${groupMemory.content}`);
      }
    }
    if (targetMemory.content) {
      parts.push(
        targetMemory.isGroupMemory
          ? `群记忆:\n${targetMemory.content}`
          : `用户 ${targetMemory.userId} 的记忆:\n${targetMemory.content}`,
      );
    }

    const reply =
      parts.length > 0
        ? parts.join('\n\n')
        : targetUserId
          ? `未找到用户 ${targetUserId} 在当前群的记忆`
          : '当前群没有已存储的记忆';

    return this.success(reply, {
      groupId,
      targetUserId: targetUserId ?? GROUP_MEMORY_USER_ID,
      isGroupMemory: !targetUserId,
      content: targetMemory.content,
      includedGroupMemory: includeGroupMemory && targetUserId,
    });
  }
}
