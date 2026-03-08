// Get memory task executor - reads group/user memory slots for local tool use

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

@TaskDefinition({
  name: 'get_memory',
  description: 'Read local memory for the current group or a specific user in the group',
  executor: 'get_memory',
  parameters: {
    userId: {
      type: 'string',
      required: false,
      description:
        'Target user ID. Omit to read group memory; set to another user ID to read that user memory in this group.',
    },
    includeGroupMemory: {
      type: 'boolean',
      required: false,
      description: 'When true and userId is provided, include group memory alongside the target user memory.',
    },
  },
  examples: ['读取当前群记忆', '查看这个用户在本群的记忆', '读取群里的长期记忆'],
  triggerKeywords: ['记忆', 'memory', '群记忆', '用户记忆'],
  whenToUse:
    'Use when you need stored local memory about the current group or a specific user in the current group. This is local app memory, not general world knowledge.',
})
@injectable()
export class GetMemoryTaskExecutor extends BaseTaskExecutor {
  name = 'get_memory';

  constructor(@inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService) {
    super();
  }

  execute(task: Task, context: TaskExecutionContext): TaskResult {
    const groupId = context.groupId?.toString();
    if (!groupId) {
      return this.error('只有群聊场景下才能读取本地记忆', 'get_memory requires group context');
    }

    const userIdParam = task.parameters?.userId;
    const includeGroupMemory = task.parameters?.includeGroupMemory === true;
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
