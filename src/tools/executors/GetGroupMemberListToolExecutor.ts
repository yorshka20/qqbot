// get_group_member_list tool executor - retrieves group member list via protocol API

import { inject, injectable } from 'tsyringe';
import type { APIClient } from '@/api/APIClient';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

interface GroupMemberInfo {
  user_id: number | string;
  nickname?: string;
  card?: string;
  role?: string;
  join_time?: number;
  last_sent_time?: number;
}

@Tool({
  name: 'get_group_member_list',
  description:
    '获取当前群的成员列表，包括每个成员的QQ号、昵称、群名片、角色等信息。可用于获取群成员头像（头像URL格式: https://q1.qlogo.cn/g?b=qq&nk={userId}&s=140）。',
  executor: 'get_group_member_list',
  visibility: ['subagent'],
  parameters: {},
  examples: ['获取群成员列表', '查看群里有哪些人', '获取群成员信息'],
  triggerKeywords: ['群成员', '成员列表', '群友'],
  whenToUse: '当需要获取群成员详细信息（昵称、群名片、角色）时调用。常用于群聊汇报中获取成员准确昵称和头像。',
})
@injectable()
export class GetGroupMemberListToolExecutor extends BaseToolExecutor {
  name = 'get_group_member_list';

  constructor(@inject(DITokens.API_CLIENT) private apiClient: APIClient) {
    super();
  }

  async execute(_call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId;
    if (!groupId) {
      return this.error('只有群聊场景下才能获取群成员列表', 'get_group_member_list requires group context');
    }

    try {
      logger.info(`[GetGroupMemberListTool] Fetching member list for group ${groupId}`);

      const rawResult = await this.apiClient.call<GroupMemberInfo[] | { members: GroupMemberInfo[] }>(
        'get_group_member_list',
        { group_id: Number(groupId) },
        'milky',
        15000,
      );

      // Milky API returns { members: [...] }, not a direct array
      const result = Array.isArray(rawResult)
        ? rawResult
        : rawResult && typeof rawResult === 'object' && 'members' in rawResult && Array.isArray(rawResult.members)
          ? rawResult.members
          : null;

      if (!result) {
        logger.warn(`[GetGroupMemberListTool] Unexpected response format:`, typeof rawResult, rawResult);
        return this.error('获取群成员列表失败：返回格式异常', 'Unexpected API response format');
      }

      const members = result.map((m) => ({
        userId: String(m.user_id),
        nickname: m.nickname ?? '',
        card: m.card ?? '',
        displayName: m.card || m.nickname || String(m.user_id),
        role: m.role ?? 'member',
        avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${m.user_id}&s=140`,
      }));

      const summary = members
        .slice(0, 50)
        .map((m) => `${m.displayName} (${m.userId}) [${m.role}]`)
        .join('\n');

      const reply = [
        `群 ${groupId} 共有 ${members.length} 名成员`,
        '',
        `=== 成员列表 (前${Math.min(50, members.length)}人) ===`,
        summary,
      ].join('\n');

      logger.info(`[GetGroupMemberListTool] Found ${members.length} members in group ${groupId}`);

      return this.success(reply, {
        groupId,
        memberCount: members.length,
        members,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[GetGroupMemberListTool] Failed to fetch member list:`, err);
      return this.error(`获取群成员列表失败: ${errMsg}`, errMsg);
    }
  }
}
