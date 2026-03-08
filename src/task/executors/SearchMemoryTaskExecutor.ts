// Search memory task executor - searches local group memory across users

import { inject, injectable } from 'tsyringe';
import { DITokens } from '@/core/DITokens';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

@TaskDefinition({
  name: 'search_memory',
  description: 'Search local memory in the current group, including other users',
  executor: 'search_memory',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Keyword or phrase to search in local memory files.',
    },
    userId: {
      type: 'string',
      required: false,
      description: 'Optional target user ID. Omit to search across all users in the current group.',
    },
    includeGroupMemory: {
      type: 'boolean',
      required: false,
      description: 'Whether to include group-level memory in the search. Default true.',
    },
    limit: {
      type: 'number',
      required: false,
      description: 'Maximum number of matched memory items to return. Default 5.',
    },
  },
  examples: ['搜索群里关于某人的记忆', '看看谁的记忆里提到 Unity', '在本地记忆里查找这个设定'],
  triggerKeywords: ['搜索记忆', '记忆搜索', 'memory search', '查记忆'],
  whenToUse:
    'Use when you need to search local memory files in the current group, especially to look up other users or find which memory mentions a topic.',
})
@injectable()
export class SearchMemoryTaskExecutor extends BaseTaskExecutor {
  name = 'search_memory';

  constructor(@inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService) {
    super();
  }

  execute(task: Task, context: TaskExecutionContext): TaskResult {
    const groupId = context.groupId?.toString();
    if (!groupId) {
      return this.error('只有群聊场景下才能搜索本地记忆', 'search_memory requires group context');
    }

    const query = typeof task.parameters?.query === 'string' ? task.parameters.query.trim() : '';
    if (!query) {
      return this.error('请提供要搜索的记忆关键词', 'Missing required parameter: query');
    }

    const userId = typeof task.parameters?.userId === 'string' ? task.parameters.userId.trim() : undefined;
    const includeGroupMemory = task.parameters?.includeGroupMemory !== false;
    const limit =
      typeof task.parameters?.limit === 'number' && Number.isFinite(task.parameters.limit)
        ? Math.max(1, Math.floor(task.parameters.limit))
        : 5;

    const results = this.memoryService.searchMemories(groupId, query, {
      userId,
      includeGroupMemory,
      limit,
    });

    if (results.length === 0) {
      return this.success('未找到相关记忆', {
        groupId,
        query,
        results: [],
      });
    }

    const formatted = results
      .map((result, index) => {
        const label = result.isGroupMemory ? '群记忆' : `用户 ${result.userId}`;
        return `${index + 1}. ${label}\n${result.snippet}`;
      })
      .join('\n\n');

    return this.success(formatted, {
      groupId,
      query,
      results: results.map((result) => ({
        ...result,
        userId: result.userId === GROUP_MEMORY_USER_ID ? 'group' : result.userId,
      })),
    });
  }
}
