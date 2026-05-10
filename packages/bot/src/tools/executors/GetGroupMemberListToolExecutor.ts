// get_group_member_list tool — stats (count only) or member lookup by one or more QQ ids (batch supported)

import { inject, injectable } from 'tsyringe';
import type { APIClient } from '@/api/APIClient';
import type { ProtocolName } from '@/core/config/types/protocol';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

interface GroupMemberInfo {
  user_id?: number | string;
  nickname?: string;
  card?: string;
  role?: string;
  join_time?: number;
  last_sent_time?: number;
}

function resolveProtocol(context: ToolExecutionContext): ProtocolName {
  const p = context.hookContext?.message.protocol;
  if (p === 'milky' || p === 'onebot11' || p === 'satori' || p === 'discord') {
    return p;
  }
  return 'milky';
}

/** Try to read member count from get_group_info-style payloads without listing members. */
function extractMemberCountFromGroupInfo(data: unknown): number | null {
  const tryRecord = (o: Record<string, unknown>): number | null => {
    for (const key of ['member_count', 'members_count', 'memberCount', 'sh_member_count', 'member_num']) {
      const v = o[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        return Math.floor(v);
      }
    }
    return null;
  };

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const root = data as Record<string, unknown>;
  const direct = tryRecord(root);
  if (direct !== null) {
    return direct;
  }
  const inner = root.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return tryRecord(inner as Record<string, unknown>);
  }
  return null;
}

/** Parallel get_group_member_info calls per wave (implementation only; not a cap on array length). */
const MEMBER_FETCH_CONCURRENCY = 5;

function normalizeUserIdArg(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(Math.trunc(raw));
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

/** Parse `user_ids` / `userIds` only (single QQ → one-element array). Deduplicates, preserves order. */
function parseUserIdsParam(params: Record<string, unknown>): string[] {
  const rawList = params.user_ids ?? params.userIds;
  if (!Array.isArray(rawList)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    const id = normalizeUserIdArg(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function mapInChunks<T, R>(items: T[], chunkSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const part = await Promise.all(chunk.map((item) => fn(item)));
    out.push(...part);
  }
  return out;
}

function parseMemberRecord(
  raw: unknown,
  fallbackUserId: string,
): {
  userId: string;
  nickname: string;
  card: string;
  displayName: string;
  role: string;
  avatarUrl: string;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const o = raw as GroupMemberInfo & Record<string, unknown>;
  const uidRaw = o.user_id ?? o.userId ?? fallbackUserId;
  const userId = String(uidRaw);
  const nickname = typeof o.nickname === 'string' ? o.nickname : '';
  const card = typeof o.card === 'string' ? o.card : '';
  const role = typeof o.role === 'string' ? o.role : 'member';
  const displayName = card || nickname || userId;
  const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=140`;
  return { userId, nickname, card, displayName, role, avatarUrl };
}

@Tool({
  name: 'get_group_member_list',
  description:
    '群成员查询（二选一，必须通过参数 mode 指定）。mode=stats：仅返回当前群人数。mode=member：传入 user_ids（QQ 号数组，单个也传一个元素）查询在本群的昵称、群名片、角色与头像 URL；不要用于拉取全群成员列表。',
  executor: 'get_group_member_list',
  visibility: { subagent: true },
  parameters: {
    mode: {
      type: 'string',
      required: true,
      description: 'stats = 仅统计人数；member = 查询成员。mode=member 时在同一 JSON 中传 user_ids（QQ 号数组）。',
    },
  },
  examples: [
    '{"mode":"stats"}',
    '{"mode":"member","user_ids":["3412420994"]}',
    '{"mode":"member","user_ids":["3412420994","3215481708"]}',
  ],
  triggerKeywords: ['群人数', '群成员', '群名片', '成员信息'],
  whenToUse: 'stats：只要群人数。member：传 user_ids 数组。禁止拉全群列表。',
})
@injectable()
export class GetGroupMemberListToolExecutor extends BaseToolExecutor {
  name = 'get_group_member_list';

  constructor(@inject(DITokens.API_CLIENT) private apiClient: APIClient) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const groupId = context.groupId;
    if (!groupId) {
      return this.error('只有群聊场景下才能使用群成员工具', 'get_group_member_list requires group context');
    }

    const modeRaw = call.parameters.mode;
    const mode = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
    const protocol = resolveProtocol(context);

    try {
      if (mode === 'stats' || mode === 'count' || mode === 'stat') {
        return await this.runStats(Number(groupId), protocol);
      }
      if (mode === 'member' || mode === 'user' || mode === 'lookup') {
        const userIds = parseUserIdsParam(call.parameters);
        if (userIds.length === 0) {
          return this.error(
            'mode=member 时必须提供 user_ids：非空数组，元素为 QQ 号（查一人则传一个元素）',
            'get_group_member_list member mode requires user_ids array',
          );
        }
        return await this.runMemberLookups(Number(groupId), userIds, protocol);
      }
      return this.error(
        `无效参数 mode="${modeRaw ?? ''}"，请使用 stats 或 member`,
        'Invalid mode for get_group_member_list',
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[GetGroupMemberListTool] Failed:`, err);
      return this.error(`群成员工具执行失败: ${errMsg}`, errMsg);
    }
  }

  private async runStats(groupId: number, protocol: ProtocolName): Promise<ToolResult> {
    const count = await this.fetchMemberCount(groupId, protocol);
    const reply = `本群共 ${count} 人`;
    logger.info(`[GetGroupMemberListTool] stats group=${groupId} count=${count} protocol=${protocol}`);
    return this.success(reply);
  }

  private async fetchMemberCount(groupId: number, protocol: ProtocolName): Promise<number> {
    if (protocol === 'milky' || protocol === 'onebot11' || protocol === 'satori') {
      try {
        const info = await this.apiClient.call<unknown>('get_group_info', { group_id: groupId }, protocol, 15000);
        const n = extractMemberCountFromGroupInfo(info);
        if (n !== null) {
          return n;
        }
        logger.debug(`[GetGroupMemberListTool] get_group_info had no member count, falling back to list length`);
      } catch (e) {
        logger.debug(`[GetGroupMemberListTool] get_group_info failed, falling back to member list:`, e);
      }
    }

    const rawResult = await this.apiClient.call<GroupMemberInfo[] | { members: GroupMemberInfo[] }>(
      'get_group_member_list',
      { group_id: groupId },
      protocol,
      60000,
    );
    const list = Array.isArray(rawResult)
      ? rawResult
      : rawResult && typeof rawResult === 'object' && 'members' in rawResult && Array.isArray(rawResult.members)
        ? rawResult.members
        : null;
    if (!list) {
      throw new Error('获取群成员列表失败：返回格式异常');
    }
    return list.length;
  }

  private async runMemberLookups(groupId: number, userIds: string[], protocol: ProtocolName): Promise<ToolResult> {
    const blocks = await mapInChunks(userIds, MEMBER_FETCH_CONCURRENCY, (uid) =>
      this.fetchMemberDetailBlock(groupId, uid, protocol, userIds.length > 1),
    );

    if (userIds.length === 1) {
      const text = blocks[0];
      if (text.startsWith('[错误]')) {
        return this.error(text.replace(/^\[错误\]\s*/, ''), text);
      }
      logger.info(`[GetGroupMemberListTool] member lookup group=${groupId} user=${userIds[0]}`);
      return this.success(text);
    }

    const reply = [`群 ${groupId} 成员信息（${userIds.length} 人）`, '', ...blocks].join('\n');
    logger.info(`[GetGroupMemberListTool] member batch group=${groupId} count=${userIds.length}`);
    return this.success(reply);
  }

  /**
   * @param batchSection - true: prefix block with "--- QQ ... ---"; false: single-user compact header
   */
  private async fetchMemberDetailBlock(
    groupId: number,
    userId: string,
    protocol: ProtocolName,
    batchSection: boolean,
  ): Promise<string> {
    const uidNum = Number(userId);
    if (!Number.isFinite(uidNum)) {
      return batchSection ? `[错误] --- QQ ${userId} ---\n无效 QQ 号` : '[错误] user_id 不是有效的数字 QQ 号';
    }

    try {
      const rawResult = await this.apiClient.call<unknown>(
        'get_group_member_info',
        { group_id: groupId, user_id: uidNum },
        protocol,
        15000,
      );

      const payload =
        rawResult &&
        typeof rawResult === 'object' &&
        !Array.isArray(rawResult) &&
        'data' in (rawResult as object) &&
        (rawResult as { data?: unknown }).data !== undefined
          ? (rawResult as { data: unknown }).data
          : rawResult;

      const m = parseMemberRecord(payload, userId);
      if (!m) {
        const msg = `未找到群 ${groupId} 中 QQ ${userId} 的成员信息（可能不在群内或数据异常）`;
        return batchSection ? `--- QQ ${userId} ---\n${msg}` : `[错误] ${msg}`;
      }

      const avatarLine =
        protocol === 'discord' ? '- 头像: (Discord 成员头像请通过客户端查看)' : `- 头像: ${m.avatarUrl}`;

      const lines = [
        `- 显示名: ${m.displayName}`,
        `- 昵称: ${m.nickname || '(空)'}`,
        `- 群名片: ${m.card || '(空)'}`,
        `- 角色: ${m.role}`,
        avatarLine,
      ];

      if (batchSection) {
        return [`--- QQ ${m.userId} ---`, ...lines].join('\n');
      }

      return [`群 ${groupId} 成员（QQ ${m.userId}）`, ...lines].join('\n');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return batchSection ? `--- QQ ${userId} ---\n查询失败: ${errMsg}` : `[错误] ${errMsg}`;
    }
  }
}
