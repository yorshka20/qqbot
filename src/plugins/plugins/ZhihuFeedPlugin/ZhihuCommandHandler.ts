// Zhihu command handler — /zhihu <subcommand> [args]
// Gives QQ bot users access to Zhihu feed data and content

import { MessageBuilder } from '@/message/MessageBuilder';
import type { ZhihuDatabase } from '@/services/zhihu/ZhihuDatabase';
import type { ZhihuFeedService } from '@/services/zhihu/ZhihuFeedService';
import { logger } from '@/utils/logger';
import type { CommandContext, CommandHandler, CommandResult, PermissionLevel } from '../../../command/types';

const USAGE = `
/zhihu status              — 知乎服务状态
/zhihu feed [count]        — 最近的关注动态（默认20条）
/zhihu articles [keyword]  — 已抓取的文章（可按标题过滤）
/zhihu answers [keyword]   — 已抓取的回答（可按标题过滤）
/zhihu content <type> <id> — 查看文章/回答正文（type=article|answer）
/zhihu search <keyword>    — 搜索文章/回答内容
`.trim();

export class ZhihuCommandHandler implements CommandHandler {
  name = 'zhihu';
  description = '查询知乎数据（只读）';
  usage = '/zhihu <subcommand>';
  permissions: PermissionLevel[] = ['owner', 'admin'];

  constructor(
    private readonly feedService: ZhihuFeedService,
    private readonly db: ZhihuDatabase,
  ) {}

  async execute(args: string[], _context: CommandContext): Promise<CommandResult> {
    const sub = args[0]?.toLowerCase() ?? '';

    try {
      switch (sub) {
        case 'status':
          return this.handleStatus();
        case 'feed':
          return this.handleFeed(Number(args[1]) || 20);
        case 'articles':
          return this.handleContents('article', args.slice(1).join(' ').trim());
        case 'answers':
          return this.handleContents('answer', args.slice(1).join(' ').trim());
        case 'content':
          return this.handleContent(args[1] ?? '', Number(args[2]) || 0);
        case 'search':
          return this.handleSearch(args.slice(1).join(' ').trim());
        default:
          return ok(USAGE);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[ZhihuCommandHandler] sub=${sub} error:`, err);
      return { success: false, error: `知乎 API 错误: ${msg}` };
    }
  }

  // ──────────────────────────────────────────────────
  // Subcommand implementations
  // ──────────────────────────────────────────────────

  private handleStatus(): CommandResult {
    const stats = this.feedService.getStats();
    const lastFetch = stats.lastFetchTs
      ? new Date(stats.lastFetchTs * 1000).toLocaleString('zh-CN')
      : '从未';

    const b = new MessageBuilder();
    b.text('知乎服务状态\n');
    b.text(`Cookie: ${stats.cookieValid ? '有效 ✓' : '无效 ✗'}\n`);
    b.text(`动态总数: ${stats.totalItems}\n`);
    b.text(`最后抓取: ${lastFetch}\n`);

    if (stats.contentStats.length > 0) {
      b.text('\n已抓取内容:\n');
      for (const s of stats.contentStats) {
        b.text(`  ${s.targetType}: ${s.count} 篇\n`);
      }
    }

    if (stats.countByVerb.length > 0) {
      b.text('\n按类型:\n');
      for (const v of stats.countByVerb) {
        b.text(`  ${getVerbLabel(v.verb)}: ${v.count}\n`);
      }
    }
    return ok(b);
  }

  private handleFeed(count: number): CommandResult {
    const limit = Math.min(Math.max(count, 1), 50);
    const items = this.feedService.getRecentItems(limit);

    if (items.length === 0) return ok('暂无知乎动态');

    const lines = items.map((item) => {
      const time = new Date(item.createdTime * 1000).toLocaleDateString('zh-CN');
      const label = getVerbLabel(item.verb);
      const actors = JSON.parse(item.actorNames || '[]') as string[];
      const actorStr = actors.length > 0 ? ` (${actors.join(', ')})` : '';
      return `[${time}] [${label}] ${item.title}\n  ${item.authorName}${actorStr} | 👍${item.voteupCount} 💬${item.commentCount}\n  ${item.url}`;
    });

    const b = new MessageBuilder();
    b.text(`知乎动态（最近 ${items.length} 条）\n\n`);
    b.text(lines.join('\n\n'));
    return ok(b);
  }

  private handleContents(targetType: string, keyword: string): CommandResult {
    const rows = keyword
      ? this.db.searchContents(keyword, 20).filter((r) => r.targetType === targetType)
      : this.db.getRecentContents(20, targetType);

    const label = targetType === 'article' ? '文章' : '回答';

    if (rows.length === 0) {
      return ok(keyword ? `没有找到包含 "${keyword}" 的${label}` : `暂无已抓取的${label}`);
    }

    const lines = rows.map((r) => {
      const time = new Date(r.createdTime * 1000).toLocaleDateString('zh-CN');
      const excerpt = r.excerpt ? r.excerpt.substring(0, 80) : '';
      return `[${time}] ${r.title}\n  作者: ${r.authorName} | 👍${r.voteupCount} 💬${r.commentCount}\n  ${excerpt ? `摘要: ${excerpt}…` : ''}\n  ${r.url}`;
    });

    const b = new MessageBuilder();
    b.text(`知乎${label}（${rows.length} 篇${keyword ? `，筛选: "${keyword}"` : ''}）\n\n`);
    b.text(lines.join('\n\n'));
    return ok(b);
  }

  private handleContent(targetType: string, targetId: number): CommandResult {
    if (!targetType || !targetId) {
      return { success: false, error: '用法: /zhihu content <article|answer> <id>\n例如: /zhihu content article 2017528295286133070' };
    }
    if (targetType !== 'article' && targetType !== 'answer') {
      return { success: false, error: '类型必须是 article 或 answer' };
    }

    const row = this.db.getContent(targetType, targetId);
    if (!row) return ok(`未找到 ${targetType} ${targetId} 的内容`);

    const b = new MessageBuilder();
    b.text(`${row.title}\n`);
    b.text(`作者: ${row.authorName} | 👍${row.voteupCount} 💬${row.commentCount}\n`);
    if (row.questionTitle) b.text(`问题: ${row.questionTitle}\n`);
    b.text(`链接: ${row.url}\n\n`);

    // Truncate content for QQ message (max ~2000 chars)
    const content = row.content || row.excerpt || '（无正文）';
    b.text(content.length > 2000 ? `${content.substring(0, 2000)}…\n\n（正文已截断，完整内容请访问链接）` : content);
    return ok(b);
  }

  private handleSearch(keyword: string): CommandResult {
    if (!keyword) return { success: false, error: '请输入搜索关键词，例如: /zhihu search AI' };

    const rows = this.db.searchContents(keyword, 20);
    if (rows.length === 0) return ok(`没有找到包含 "${keyword}" 的内容`);

    const lines = rows.map((r) => {
      const type = r.targetType === 'article' ? '文章' : '回答';
      const time = new Date(r.createdTime * 1000).toLocaleDateString('zh-CN');
      return `[${type}] [${time}] ${r.title}\n  作者: ${r.authorName} | 👍${r.voteupCount}\n  ${r.url}`;
    });

    const b = new MessageBuilder();
    b.text(`搜索 "${keyword}" 结果（${rows.length} 条）\n\n`);
    b.text(lines.join('\n\n'));
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

function getVerbLabel(verb: string): string {
  switch (verb) {
    case 'ANSWER_CREATE':
      return '新回答';
    case 'ARTICLE_CREATE':
      return '新文章';
    case 'ANSWER_VOTE_UP':
    case 'MEMBER_VOTEUP_ANSWER':
      return '赞同回答';
    case 'MEMBER_VOTEUP_ARTICLE':
      return '赞同文章';
    case 'MEMBER_ANSWER_QUESTION':
      return '回答问题';
    case 'MEMBER_FOLLOW_QUESTION':
    case 'QUESTION_FOLLOW':
      return '关注问题';
    case 'ZVIDEO_CREATE':
      return '新视频';
    default:
      return verb;
  }
}
