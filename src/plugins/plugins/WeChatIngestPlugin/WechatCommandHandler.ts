// WeChat command handler — /wechat <subcommand> [args]
// Gives QQ bot users access to WeChat data via read-only PadPro API

import { MessageBuilder } from '@/message/MessageBuilder';
import type {
  WeChatDatabase,
  WeChatPadProClient,
  WXGroupInfo,
  WXGroupMember,
  WXMoment,
  WXOfficialAccount,
  WXSearchResult,
} from '@/services/wechat';
import { logger } from '@/utils/logger';
import type { CommandContext, CommandHandler, CommandResult, PermissionLevel } from '../../../command/types';

const USAGE = `
/wechat status              — 微信登录状态
/wechat me                  — 我的微信资料
/wechat contacts [keyword]  — 好友列表（可按昵称/备注过滤）
/wechat groups              — 所有群列表
/wechat group <groupId>     — 群详情+成员（groupId不含@chatroom）
/wechat moments [wxid]      — 朋友圈（不填wxid=自己）
/wechat search <query>      — 搜索联系人（微信号/手机/QQ）
/wechat official            — 关注的公众号
/wechat articles [keyword]  — 已收录公众号文章（按标题/来源过滤）
/wechat history [count]     — 同步最新消息（默认20条）
/wechat fav                 — 收藏列表
`.trim();

export class WechatCommandHandler implements CommandHandler {
  name = 'wechat';
  description = '查询微信数据（只读）';
  usage = '/wechat <subcommand>';
  permissions: PermissionLevel[] = ['owner', 'admin'];

  constructor(
    private readonly client: WeChatPadProClient,
    private readonly db: WeChatDatabase | null = null,
  ) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const sub = args[0]?.toLowerCase() ?? '';

    try {
      switch (sub) {
        case 'status':
          return this.handleStatus();
        case 'me':
          return this.handleMe();
        case 'contacts':
          return this.handleContacts(args.slice(1).join(' ').trim());
        case 'groups':
          return this.handleGroups();
        case 'group':
          return this.handleGroup(args[1] ?? '');
        case 'moments':
          return this.handleMoments(args[1]);
        case 'search':
          return this.handleSearch(args.slice(1).join(' ').trim());
        case 'official':
          return this.handleOfficial();
        case 'articles':
          return this.handleArticles(args.slice(1).join(' ').trim());
        case 'history':
          return this.handleHistory(Number(args[1] ?? 20));
        case 'fav':
          return this.handleFav();
        default:
          return ok(USAGE);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[WechatCommandHandler] sub=${sub} error:`, err);
      return { success: false, error: `WeChat API 错误: ${msg}` };
    }
  }

  // ──────────────────────────────────────────────────
  // Subcommand implementations
  // ──────────────────────────────────────────────────

  private async handleStatus(): Promise<CommandResult> {
    const s = await this.client.getLoginStatus();
    const online = s.loginState === 1;

    const b = new MessageBuilder();
    b.text(`微信状态\n`);
    b.text(`状态: ${online ? '在线 ✓' : '离线'}\n`);
    if (s.loginTime) b.text(`登录时间: ${s.loginTime}\n`);
    if (s.onlineTime) b.text(`${s.onlineTime}\n`);
    if (s.totalOnline) b.text(`${s.totalOnline}\n`);
    if (s.expiryTime) b.text(`授权到期: ${s.expiryTime}`);
    return ok(b);
  }

  private async handleMe(): Promise<CommandResult> {
    const p = await this.client.getProfile();
    const nick = p.NickName ?? '—';
    const alias = p.Alias ?? '—';
    const sig = p.Signature ?? '—';
    const loc = [p.Province ?? '', p.City ?? ''].filter(Boolean).join(' ') || '—';
    const sex = (p.Sex ?? 0) === 1 ? '男' : (p.Sex ?? 0) === 2 ? '女' : '—';

    const b = new MessageBuilder();
    b.text(`我的资料\n`);
    b.text(`昵称: ${nick}\n`);
    b.text(`微信号: ${alias}\n`);
    b.text(`性别: ${sex}\n`);
    b.text(`地区: ${loc}\n`);
    b.text(`签名: ${sig}`);
    return ok(b);
  }

  private async handleContacts(keyword: string): Promise<CommandResult> {
    const list = await this.client.getFriendList();
    const filtered = keyword
      ? list.filter(
          (c) => matchStr(c.NickName, keyword) || matchStr(c.Remark, keyword) || matchStr(c.UserName, keyword),
        )
      : list;

    if (filtered.length === 0) {
      return ok(keyword ? `没有找到匹配 "${keyword}" 的好友` : '好友列表为空');
    }

    const lines = filtered.slice(0, 30).map((c) => {
      const name = c.Remark ? `${c.Remark}(${c.NickName ?? ''})` : (c.NickName ?? c.UserName ?? '—');
      return `${name}  ${c.UserName ?? ''}`;
    });

    const b = new MessageBuilder();
    b.text(`好友列表 (${filtered.length}人，显示前30)\n\n`);
    b.text(lines.join('\n'));
    if (filtered.length > 30) b.text(`\n…还有 ${filtered.length - 30} 人`);
    return ok(b);
  }

  private async handleGroups(): Promise<CommandResult> {
    const list = await this.client.getAllGroupList();
    if (list.length === 0) return ok('群列表为空');

    const lines = list.slice(0, 30).map((g) => {
      const name = g.NickName ?? g.ChatRoomName ?? '未知群';
      const id = g.ChatRoomName ?? '';
      const count = g.MemberCount ? `(${g.MemberCount}人)` : '';
      return `${name} ${count}  ID: ${id}`;
    });

    const b = new MessageBuilder();
    b.text(`群列表 (共${list.length}个，显示前30)\n\n`);
    b.text(lines.join('\n'));
    if (list.length > 30) b.text(`\n…还有 ${list.length - 30} 个群`);
    return ok(b);
  }

  private async handleGroup(groupId: string): Promise<CommandResult> {
    if (!groupId) return { success: false, error: '请提供群ID，例如: /wechat group 12345678901' };

    const fullId = groupId.endsWith('@chatroom') ? groupId : `${groupId}@chatroom`;
    const [infos, members] = await Promise.all([
      this.client.getChatRoomInfo([fullId]).catch(() => [] as WXGroupInfo[]),
      this.client.getChatroomMemberDetail(fullId).catch(() => [] as WXGroupMember[]),
    ]);

    const info = infos[0] as (WXGroupInfo & Record<string, unknown>) | undefined;
    const name = info?.NickName ?? info?.nickName ?? groupId;
    const announcement = info?.Announcement ?? info?.announcement ?? '无';
    const owner = info?.Owner ?? info?.owner ?? '—';
    const memberCount = members.length > 0 ? members.length : (info?.MemberCount ?? '?');

    const memberLines = members
      .slice(0, 20)
      .map((m) => {
        const display = m.DisplayName ?? m.NickName ?? m.UserName ?? '—';
        return `  ${display} (${m.UserName ?? ''})`;
      })
      .join('\n');

    const b = new MessageBuilder();
    b.text(`群: ${name}\n`);
    b.text(`ID: ${fullId}\n`);
    b.text(`群主: ${owner}\n`);
    b.text(`人数: ${memberCount}\n`);
    b.text(`公告: ${String(announcement).substring(0, 100)}\n`);
    b.text(`\n成员（前20）:\n${memberLines}`);
    if (members.length > 20) b.text(`\n…还有 ${members.length - 20} 人`);
    return ok(b);
  }

  private async handleMoments(wxid?: string): Promise<CommandResult> {
    let moments: WXMoment[];
    if (wxid) {
      moments = await this.client.getUserMoments(wxid);
    } else {
      moments = await this.client.getMomentsTimeline();
    }

    if (moments.length === 0) {
      return ok(wxid ? `${wxid} 的朋友圈为空或无法访问` : '朋友圈暂无内容');
    }

    const lines = moments.slice(0, 10).map((m) => {
      const who = m.nickName ?? m.userName ?? '?';
      const time = m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : '';
      const text = extractMomentText(m);
      return `[${time}] ${who}: ${text.substring(0, 80)}`;
    });

    const b = new MessageBuilder();
    b.text(`朋友圈 (最新${moments.length}条)\n\n`);
    b.text(lines.join('\n\n'));
    return ok(b);
  }

  private async handleSearch(query: string): Promise<CommandResult> {
    if (!query) return { success: false, error: '请输入搜索内容，例如: /wechat search wxid_xxx' };

    const result = (await this.client.searchContact(query)) as (WXSearchResult & Record<string, unknown>) | null;
    if (!result) return ok(`未找到: ${query}`);

    const nick = result.NickName ?? result.nickName ?? '—';
    const alias = result.Alias ?? result.alias ?? query;
    const loc = [result.Province ?? '', result.City ?? ''].filter(Boolean).join(' ') || '—';
    const sig = result.Signature ?? result.signature ?? '—';
    const sex = (result.Sex ?? 0) === 1 ? '男' : (result.Sex ?? 0) === 2 ? '女' : '—';

    const b = new MessageBuilder();
    b.text(`搜索结果\n`);
    b.text(`昵称: ${nick}\n`);
    b.text(`微信号: ${alias}\n`);
    b.text(`性别: ${sex}\n`);
    b.text(`地区: ${loc}\n`);
    b.text(`签名: ${sig}`);
    return ok(b);
  }

  private async handleOfficial(): Promise<CommandResult> {
    const list = await this.client.getOfficialAccountList();
    if (list.length === 0) return ok('未关注任何公众号');

    const lines = list.slice(0, 20).map((oa) => {
      const name =
        (oa as WXOfficialAccount & Record<string, unknown>).NickName ??
        (oa as Record<string, unknown>).nickName ??
        oa.UserName ??
        '—';
      return `${name}  (${oa.UserName ?? ''})`;
    });

    const b = new MessageBuilder();
    b.text(`关注的公众号 (${list.length}个)\n\n`);
    b.text(lines.join('\n'));
    return ok(b);
  }

  private handleArticles(keyword: string): CommandResult {
    if (!this.db) return ok('未启用本地数据库，无法查询文章');

    const rows = this.db.getRecentOAArticles(20, keyword || undefined);
    if (rows.length === 0) {
      return ok(
        keyword ? `没有找到包含 "${keyword}" 的文章` : '暂无已收录的公众号文章（公众号推送后自动收录）',
      );
    }

    const lines = rows.map((r) => {
      const time = r.pubTime
        ? new Date(r.pubTime * 1000).toLocaleDateString('zh-CN')
        : new Date(r.receivedAt).toLocaleDateString('zh-CN');
      const account = r.accountNick || r.accountId;
      const summary = r.summary ? `\n  摘要: ${r.summary.substring(0, 60)}…` : '';
      return `[${time}] ${r.title}\n  公众号: ${account}${summary}`;
    });

    const b = new MessageBuilder();
    b.text(`已收录公众号文章 (${rows.length}条${keyword ? `，筛选: "${keyword}"` : ''})\n\n`);
    b.text(lines.join('\n\n'));
    return ok(b);
  }

  private async handleHistory(count: number): Promise<CommandResult> {
    const n = Number.isFinite(count) && count > 0 ? Math.min(count, 50) : 20;
    const msgs = await this.client.syncMessages(n);

    if (msgs.length === 0) return ok('暂无待同步消息');

    const lines = msgs.slice(0, 20).map((m) => {
      const from = m.FromUserName ?? '?';
      const time = m.CreateTime ? new Date(m.CreateTime * 1000).toLocaleString('zh-CN') : '';
      const text = (m.Content ?? '').substring(0, 60).replace(/\n/g, ' ');
      return `[${time}] ${from}: ${text}`;
    });

    const b = new MessageBuilder();
    b.text(`最近消息 (${msgs.length}条，显示前20)\n\n`);
    b.text(lines.join('\n'));
    return ok(b);
  }

  private async handleFav(): Promise<CommandResult> {
    const favs = await this.client.getFavoriteList();
    if (favs.length === 0) return ok('收藏列表为空');

    const lines = favs.slice(0, 15).map((f) => {
      const typeLabel = f.Type === 1 ? '文字' : f.Type === 2 ? '图片' : f.Type === 5 ? '链接' : `类型${f.Type ?? '?'}`;
      const time = f.UpdateTime ? new Date(f.UpdateTime * 1000).toLocaleDateString('zh-CN') : '';
      return `${time} [${typeLabel}] #${f.FavId ?? '?'}`;
    });

    const b = new MessageBuilder();
    b.text(`收藏列表 (${favs.length}项，显示前15)\n\n`);
    b.text(lines.join('\n'));
    return ok(b);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function ok(content: string | MessageBuilder): CommandResult {
  const b = typeof content === 'string' ? new MessageBuilder().text(content) : content;
  return { success: true, segments: b.build() };
}

function matchStr(value: string | undefined, keyword: string): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(keyword.toLowerCase());
}

function extractMomentText(m: WXMoment): string {
  // Moment content is base64-encoded XML in objectDesc.buffer — show metadata instead
  const parts: string[] = [];
  if (m.likeCount) parts.push(`❤️${m.likeCount}`);
  if (m.commentCount) parts.push(`💬${m.commentCount}`);
  return parts.length > 0 ? parts.join(' ') : '（朋友圈动态）';
}
