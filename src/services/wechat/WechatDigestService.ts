// WechatDigestService - provides granular WeChat data queries
// Used by task executors for group summaries, article analysis, stats, and search

import { logger } from '@/utils/logger';
import type { WeChatDatabase, WeChatMessageRow } from './WeChatDatabase';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Formatted group message summary */
export interface GroupSummary {
  conversationId: string;
  messageCount: number;
  senderCount: number;
  senders: string[];
  formattedMessages: string;
  categories: string[];
}

/** Formatted article summary */
export interface ArticleSummary {
  title: string;
  url: string;
  summary: string;
  source: string;
  accountNick: string;
  sourceType: string;
  sharedBy?: string;
  sharedIn?: string;
  pubTime: number;
}

/** Overall statistics */
export interface WechatStats {
  period: string;
  sinceTs: number;
  messages: {
    total: number;
    groups: number;
    private: number;
    groupCount: number;
    privateCount: number;
  };
  articles: {
    total: number;
    oaPush: number;
    shared: number;
  };
  topGroups: Array<{
    conversationId: string;
    messageCount: number;
    senderCount: number;
  }>;
  topAccounts: Array<{
    accountNick: string;
    articleCount: number;
  }>;
}

/** Search result */
export interface WechatSearchResult {
  type: 'message' | 'article';
  content: string;
  source: string;
  time: number;
  url?: string;
  metadata: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// WechatDigestService
// ────────────────────────────────────────────────────────────────────────────

export class WechatDigestService {
  constructor(private db: WeChatDatabase) {
    logger.info('[WechatDigestService] Initialized');
  }

  // ──────────────────────────────────────────────────
  // Group messages
  // ──────────────────────────────────────────────────

  /**
   * Get group message summaries.
   * @param sinceTs - Unix timestamp (seconds). Defaults to today start.
   * @param conversationId - Optional: filter to specific group
   * @param maxMessagesPerGroup - Max messages to include per group (default 50)
   */
  getGroupSummaries(sinceTs?: number, conversationId?: string, maxMessagesPerGroup = 50): GroupSummary[] {
    const since = sinceTs ?? this.db.getTodayStartTs();

    const messages = this.db.getMessages({
      sinceTs: since,
      isGroup: true,
      conversationId,
      limit: 2000,
    });

    if (messages.length === 0) return [];

    // Group by conversationId
    const grouped = new Map<string, WeChatMessageRow[]>();
    for (const msg of messages) {
      const existing = grouped.get(msg.conversationId);
      if (existing) {
        existing.push(msg);
      } else {
        grouped.set(msg.conversationId, [msg]);
      }
    }

    const summaries: GroupSummary[] = [];

    for (const [convId, msgs] of grouped) {
      const senders = [...new Set(msgs.map((m) => m.sender))];
      const categories = [...new Set(msgs.map((m) => m.category))];

      // Sort by time ascending and limit
      const sortedMsgs = msgs.sort((a, b) => a.createTime - b.createTime);
      const limitedMsgs = sortedMsgs.slice(-maxMessagesPerGroup);

      const formattedLines: string[] = [];
      for (const m of limitedMsgs) {
        const time = this.formatTime(m.createTime);
        const sender = m.sender || 'unknown';
        const content = this.formatMessageContent(m);
        formattedLines.push(`[${time}] ${sender}: ${content}`);
      }

      if (msgs.length > maxMessagesPerGroup) {
        formattedLines.unshift(`> 显示最近 ${maxMessagesPerGroup} 条，共 ${msgs.length} 条`);
      }

      summaries.push({
        conversationId: convId,
        messageCount: msgs.length,
        senderCount: senders.length,
        senders,
        formattedMessages: formattedLines.join('\n'),
        categories,
      });
    }

    // Sort by message count descending
    return summaries.sort((a, b) => b.messageCount - a.messageCount);
  }

  /**
   * Get formatted group summary text for a specific group or all groups.
   */
  getGroupSummaryText(sinceTs?: number, conversationId?: string): string {
    const summaries = this.getGroupSummaries(sinceTs, conversationId);

    if (summaries.length === 0) {
      return '暂无群聊消息。';
    }

    const sections: string[] = [];
    for (const s of summaries) {
      sections.push(
        `### ${s.conversationId}\n` +
          `消息数: ${s.messageCount} | 发言人: ${s.senderCount}\n` +
          `类型: ${s.categories.join(', ')}\n\n` +
          s.formattedMessages,
      );
    }

    return sections.join('\n\n---\n\n');
  }

  // ──────────────────────────────────────────────────
  // Articles
  // ──────────────────────────────────────────────────

  /**
   * Get article summaries with optional filters.
   */
  getArticleSummaries(options?: {
    sinceTs?: number;
    sourceType?: 'oa_push' | 'group_chat' | 'private_chat' | 'all';
    keyword?: string;
    limit?: number;
  }): ArticleSummary[] {
    const sinceTs = options?.sinceTs ?? this.db.getTodayStartTs();
    const sourceType = options?.sourceType === 'all' ? undefined : options?.sourceType;

    const articles = this.db.getArticles({
      sinceTs,
      sourceType,
      keyword: options?.keyword,
      limit: options?.limit ?? 100,
    });

    return articles.map((a) => ({
      title: a.title,
      url: a.url,
      summary: a.summary,
      source: a.source,
      accountNick: a.accountNick,
      sourceType: a.sourceType,
      sharedBy: a.fromSender || undefined,
      sharedIn: a.fromConversationId || undefined,
      pubTime: a.pubTime,
    }));
  }

  /**
   * Get formatted article summary text.
   */
  getArticleSummaryText(options?: {
    sinceTs?: number;
    sourceType?: 'oa_push' | 'group_chat' | 'private_chat' | 'all';
    keyword?: string;
    limit?: number;
  }): string {
    const articles = this.getArticleSummaries(options);

    if (articles.length === 0) {
      return '暂无文章。';
    }

    const lines: string[] = [];
    for (const a of articles) {
      const time = this.formatTime(a.pubTime);
      const sourceInfo =
        a.sourceType === 'oa_push'
          ? `[公众号] ${a.accountNick}`
          : `[分享] ${a.sharedBy || 'unknown'} 在 ${a.sharedIn || 'unknown'}`;

      lines.push(
        `### ${a.title}\n` +
          `${sourceInfo} | ${time}\n` +
          (a.summary ? `摘要: ${this.truncate(a.summary, 150)}\n` : '') +
          `链接: ${a.url}`,
      );
    }

    return lines.join('\n\n');
  }

  // ──────────────────────────────────────────────────
  // Statistics
  // ──────────────────────────────────────────────────

  /**
   * Get comprehensive statistics.
   */
  getStats(sinceTs?: number): WechatStats {
    const since = sinceTs ?? this.db.getTodayStartTs();
    const overall = this.db.getOverallStats(since);
    const groupStats = this.db.getGroupStats(since).slice(0, 10);
    const articleStats = this.db.getArticleStats(since).slice(0, 10);

    // Format period description
    const now = new Date();
    const sinceDate = new Date(since * 1000);
    const isSameDay = sinceDate.toDateString() === now.toDateString();
    const period = isSameDay ? '今日' : `${sinceDate.toLocaleDateString('zh-CN')} 至今`;

    return {
      period,
      sinceTs: since,
      messages: {
        total: overall.totalMessages,
        groups: overall.groupMessages,
        private: overall.privateMessages,
        groupCount: overall.groupCount,
        privateCount: overall.privateCount,
      },
      articles: {
        total: overall.articleCount,
        oaPush: overall.oaPushCount,
        shared: overall.sharedArticleCount,
      },
      topGroups: groupStats.map((g) => ({
        conversationId: g.conversationId,
        messageCount: g.messageCount,
        senderCount: g.senderCount,
      })),
      topAccounts: articleStats.map((a) => ({
        accountNick: a.accountNick,
        articleCount: a.articleCount,
      })),
    };
  }

  /**
   * Get formatted statistics text.
   */
  getStatsText(sinceTs?: number): string {
    const stats = this.getStats(sinceTs);

    const lines = [
      `## 微信消息统计（${stats.period}）`,
      '',
      '### 消息概览',
      `- 总消息: ${stats.messages.total}`,
      `- 群聊消息: ${stats.messages.groups} (${stats.messages.groupCount} 个群)`,
      `- 私聊消息: ${stats.messages.private} (${stats.messages.privateCount} 个联系人)`,
      '',
      '### 文章概览',
      `- 总文章: ${stats.articles.total}`,
      `- 公众号推送: ${stats.articles.oaPush}`,
      `- 聊天分享: ${stats.articles.shared}`,
    ];

    if (stats.topGroups.length > 0) {
      lines.push('', '### 活跃群聊 Top 10');
      for (const g of stats.topGroups) {
        lines.push(`- ${g.conversationId}: ${g.messageCount} 条消息, ${g.senderCount} 人发言`);
      }
    }

    if (stats.topAccounts.length > 0) {
      lines.push('', '### 活跃公众号 Top 10');
      for (const a of stats.topAccounts) {
        lines.push(`- ${a.accountNick}: ${a.articleCount} 篇文章`);
      }
    }

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────────
  // Search
  // ──────────────────────────────────────────────────

  /**
   * Search messages and articles by keyword.
   */
  search(
    keyword: string,
    options?: {
      sinceTs?: number;
      searchIn?: 'messages' | 'articles' | 'all';
      isGroup?: boolean;
      limit?: number;
    },
  ): WechatSearchResult[] {
    const sinceTs = options?.sinceTs;
    const searchIn = options?.searchIn ?? 'all';
    const limit = options?.limit ?? 50;
    const results: WechatSearchResult[] = [];

    // Search messages
    if (searchIn === 'messages' || searchIn === 'all') {
      const messages = this.db.searchMessages(keyword, {
        sinceTs,
        isGroup: options?.isGroup,
        limit,
      });

      for (const m of messages) {
        results.push({
          type: 'message',
          content: this.formatMessageContent(m),
          source: m.isGroup === 1 ? `群:${m.conversationId}` : `私聊:${m.conversationId}`,
          time: m.createTime,
          metadata: {
            sender: m.sender,
            category: m.category,
            conversationId: m.conversationId,
            isGroup: m.isGroup === 1,
          },
        });
      }
    }

    // Search articles
    if (searchIn === 'articles' || searchIn === 'all') {
      const articles = this.db.getArticles({
        sinceTs,
        keyword,
        limit,
      });

      for (const a of articles) {
        results.push({
          type: 'article',
          content: a.title + (a.summary ? ` - ${a.summary}` : ''),
          source: a.sourceType === 'oa_push' ? `公众号:${a.accountNick}` : `分享:${a.fromSender}`,
          time: a.pubTime,
          url: a.url,
          metadata: {
            accountId: a.accountId,
            accountNick: a.accountNick,
            sourceType: a.sourceType,
          },
        });
      }
    }

    // Sort by time descending
    results.sort((a, b) => b.time - a.time);

    return results.slice(0, limit);
  }

  /**
   * Get formatted search results text.
   */
  searchText(
    keyword: string,
    options?: {
      sinceTs?: number;
      searchIn?: 'messages' | 'articles' | 'all';
      isGroup?: boolean;
      limit?: number;
    },
  ): string {
    const results = this.search(keyword, options);

    if (results.length === 0) {
      return `未找到与 "${keyword}" 相关的内容。`;
    }

    const lines = [`## 搜索结果: "${keyword}" (${results.length} 条)`, ''];

    for (const r of results) {
      const time = this.formatTime(r.time);
      const typeLabel = r.type === 'message' ? '消息' : '文章';
      lines.push(
        `### [${typeLabel}] ${r.source} | ${time}`,
        this.truncate(r.content, 200),
        r.url ? `链接: ${r.url}` : '',
        '',
      );
    }

    return lines.filter(Boolean).join('\n');
  }

  // ──────────────────────────────────────────────────
  // Legacy: Unprocessed digest (for backward compatibility)
  // ──────────────────────────────────────────────────

  /**
   * Get unprocessed messages digest (legacy method).
   */
  async getUnprocessedDigest(
    sinceTs?: number,
    maxPerSource = 50,
  ): Promise<{
    totalCount: number;
    groupedText: string;
    sourceBreakdown: Array<{
      conversationId: string;
      isGroup: boolean;
      count: number;
      senders: string[];
    }>;
  }> {
    const since = sinceTs ?? this.db.getTodayStartTs();
    const messages = this.db.getUnprocessedSince(since);

    if (messages.length === 0) {
      return { totalCount: 0, groupedText: '', sourceBreakdown: [] };
    }

    // Use getGroupSummaries logic
    const grouped = new Map<string, WeChatMessageRow[]>();
    for (const msg of messages) {
      const existing = grouped.get(msg.conversationId);
      if (existing) {
        existing.push(msg);
      } else {
        grouped.set(msg.conversationId, [msg]);
      }
    }

    const sections: string[] = [];
    const breakdown: Array<{
      conversationId: string;
      isGroup: boolean;
      count: number;
      senders: string[];
    }> = [];

    for (const [convId, msgs] of grouped) {
      const isGroup = msgs[0]?.isGroup === 1;
      const senders = [...new Set(msgs.map((m) => m.sender))];

      breakdown.push({ conversationId: convId, isGroup, count: msgs.length, senders });

      const sortedMsgs = msgs.sort((a, b) => a.createTime - b.createTime).slice(-maxPerSource);
      const lines: string[] = [`### ${convId} (${isGroup ? '群聊' : '私聊'}, ${msgs.length}条)`];

      if (msgs.length > maxPerSource) {
        lines.push(`> 显示最近 ${maxPerSource} 条`);
      }

      for (const m of sortedMsgs) {
        const time = this.formatTime(m.createTime);
        const content = this.formatMessageContent(m);
        lines.push(`[${time}] ${m.sender}: ${content}`);
      }

      sections.push(lines.join('\n'));
    }

    return {
      totalCount: messages.length,
      groupedText: sections.join('\n\n'),
      sourceBreakdown: breakdown,
    };
  }

  /**
   * Mark messages as processed.
   */
  markProcessed(sinceTs?: number): number {
    const since = sinceTs ?? this.db.getTodayStartTs();
    return this.db.markProcessedSince(since);
  }

  /**
   * Get today start timestamp.
   */
  getTodayStartTs(): number {
    return this.db.getTodayStartTs();
  }

  // ──────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────

  private formatTime(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatMessageContent(m: WeChatMessageRow): string {
    try {
      const parsed = JSON.parse(m.content);

      switch (m.category) {
        case 'text':
          return parsed.text || m.content;
        case 'article':
          return `[链接] ${parsed.title || ''}${parsed.description ? ` - ${this.truncate(parsed.description, 60)}` : ''}`;
        case 'image':
          return parsed.filePath ? `[图片] ${parsed.filePath}` : '[图片]';
        case 'file':
          if (parsed.type === 'finder_video') {
            return `[视频号] ${parsed.nickname || ''}: ${parsed.desc || ''}`;
          }
          return `[文件] ${parsed.fileName || parsed.title || ''}`;
        default:
          return `[${m.category}] ${this.truncate(JSON.stringify(parsed), 100)}`;
      }
    } catch {
      return this.truncate(m.content, 100);
    }
  }

  private truncate(str: string, maxLen: number): string {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }
}
