// Get memory task executor - reads group/user memory slots for local tool use

import { inject, injectable } from 'tsyringe';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import { DITokens } from '@/core/DITokens';
import { GROUP_MEMORY_USER_ID, type MemoryService } from '@/memory/MemoryService';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';
import { resolveConversationScope } from './conversationScope';
import { resolveSender, SENDER_PARAM_DESCRIPTIONS } from './senderResolution';

@Tool({
  name: 'get_memory',
  description:
    '读取当前群或指定用户的本地长期记忆。返回的是 bot 过去从聊天里**提炼并沉淀下来的结论**（偏好、设定、历史事实等），不是聊天记录原文，也没有逐条的时间与出处。',
  executor: 'get_memory',
  // No `qq-private`: memory is written per group (MemoryPlugin only extracts for
  // configured groups), so a 1:1 chat has no memory slot to read and offering the
  // tool there could only ever return an error.
  visibility: {
    reply: { sources: ['qq-group', 'discord', 'avatar-cmd'] },
    subagent: true,
    reflection: true,
  },
  parameters: {
    userId: {
      type: 'string',
      required: false,
      description: `目标用户 QQ 号，省略则读取群整体记忆。${SENDER_PARAM_DESCRIPTIONS.userId}`,
    },
    nickname: {
      type: 'string',
      required: false,
      description: `读取某人的个人记忆但手上只有名字时用这个。${SENDER_PARAM_DESCRIPTIONS.nickname}`,
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
    '当你需要的是关于这个群或这个人**已经成立的结论**时调用（如"这个人有什么偏好"、"群里有什么规矩"）。这是 bot 本地记忆，不是联网搜索。想要 TA 的原话、具体时间或上下文，用 search_chat_history 取原文；这里没有。',
})
@injectable()
export class GetMemoryToolExecutor extends BaseToolExecutor {
  name = 'get_memory';

  constructor(
    @inject(DITokens.MEMORY_SERVICE) private memoryService: MemoryService,
    @inject(DITokens.CONVERSATION_HISTORY_SERVICE) private conversationHistoryService: ConversationHistoryService,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const scope = resolveConversationScope(context);
    const groupId = scope?.groupId;
    if (!groupId) {
      if (context.metadata?.reflectionScope) {
        return this.success('（reflection 上下文：当前无活跃群上下文，无法读取本地群/用户记忆）', {
          reflectionContext: true,
          reason: 'no-group',
        });
      }
      return this.error('记忆按群存储，当前会话没有对应的记忆', 'get_memory requires group context');
    }

    const includeGroupMemory = call.parameters?.includeGroupMemory === true;
    const resolution = await resolveSender(this.conversationHistoryService, scope, call.parameters ?? {});
    if (resolution.kind === 'not_found' || resolution.kind === 'ambiguous') {
      return this.success(resolution.message, { nickname: resolution.nickname });
    }
    const targetUserId = resolution.kind === 'resolved' ? resolution.userId : undefined;

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
