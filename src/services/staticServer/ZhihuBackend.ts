/**
 * Zhihu backend: REST API (/api/zhihu) for Zhihu content browsing.
 *
 * API contract:
 * - GET  /api/zhihu/contents?type=&limit=&sinceTs=&keyword=  -> { contents: ZhihuContentListItem[] }
 * - GET  /api/zhihu/content/:targetType/:targetId             -> { content: ZhihuContentDetail }
 * - GET  /api/zhihu/feed?limit=&verb=                         -> { items: ZhihuFeedListItem[] }
 * - GET  /api/zhihu/stats                                     -> { stats: ZhihuPageStats }
 */

import { getContainer } from '@/core/DIContainer';
import { ZhihuDITokens } from '@/services/zhihu/tokens';
import type { ZhihuContentRow, ZhihuFeedItemRow } from '@/services/zhihu/types';
import type { ZhihuDatabase } from '@/services/zhihu/ZhihuDatabase';
import { logger } from '@/utils/logger';

const API_PREFIX = '/api/zhihu';

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface ZhihuContentListItem {
  targetType: string;
  targetId: number;
  title: string;
  url: string;
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl: string | null;
  excerpt: string;
  voteupCount: number;
  commentCount: number;
  questionTitle: string | null;
  createdTime: number;
  fetchedAt: string;
}

export interface ZhihuContentDetail {
  targetType: string;
  targetId: number;
  title: string;
  url: string;
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl: string | null;
  content: string;
  excerpt: string;
  voteupCount: number;
  commentCount: number;
  questionId: number | null;
  questionTitle: string | null;
  createdTime: number;
  fetchedAt: string;
}

export interface ZhihuFeedListItem {
  id: string;
  verb: string;
  verbLabel: string;
  targetType: string;
  targetId: number;
  title: string;
  excerpt: string;
  url: string;
  authorName: string;
  voteupCount: number;
  commentCount: number;
  actorNames: string[];
  createdTime: number;
  hasContent: boolean;
}

export interface ZhihuPageStats {
  totalFeedItems: number;
  totalContents: number;
  contentsByType: Array<{ targetType: string; count: number }>;
  feedByVerb: Array<{ verb: string; verbLabel: string; count: number }>;
  lastFetchTs: number;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function rowToListItem(row: ZhihuContentRow): ZhihuContentListItem {
  return {
    targetType: row.targetType,
    targetId: row.targetId,
    title: row.title,
    url: row.url,
    authorName: row.authorName,
    authorUrlToken: row.authorUrlToken,
    authorAvatarUrl: row.authorAvatarUrl,
    excerpt: row.excerpt.slice(0, 200),
    voteupCount: row.voteupCount,
    commentCount: row.commentCount,
    questionTitle: row.questionTitle,
    createdTime: row.createdTime,
    fetchedAt: row.fetchedAt,
  };
}

function rowToDetail(row: ZhihuContentRow): ZhihuContentDetail {
  return {
    targetType: row.targetType,
    targetId: row.targetId,
    title: row.title,
    url: row.url,
    authorName: row.authorName,
    authorUrlToken: row.authorUrlToken,
    authorAvatarUrl: row.authorAvatarUrl,
    content: row.content,
    excerpt: row.excerpt,
    voteupCount: row.voteupCount,
    commentCount: row.commentCount,
    questionId: row.questionId,
    questionTitle: row.questionTitle,
    createdTime: row.createdTime,
    fetchedAt: row.fetchedAt,
  };
}

function feedRowToListItem(row: ZhihuFeedItemRow, db: ZhihuDatabase): ZhihuFeedListItem {
  let actorNames: string[] = [];
  try {
    actorNames = JSON.parse(row.actorNames || '[]');
  } catch {
    // ignore
  }
  return {
    id: row.id,
    verb: row.verb,
    verbLabel: getVerbLabel(row.verb),
    targetType: row.targetType,
    targetId: row.targetId,
    title: row.title,
    excerpt: row.excerpt.slice(0, 200),
    url: row.url,
    authorName: row.authorName,
    voteupCount: row.voteupCount,
    commentCount: row.commentCount,
    actorNames,
    createdTime: row.createdTime,
    hasContent: db.hasContent(row.targetType, row.targetId),
  };
}

// ---------------------------------------------------------------------------
// ZhihuBackend
// ---------------------------------------------------------------------------

export class ZhihuBackend {
  private db: ZhihuDatabase | null = null;

  private getDB(): ZhihuDatabase | null {
    if (this.db) return this.db;
    try {
      const container = getContainer();
      this.db = container.resolve<ZhihuDatabase>(ZhihuDITokens.ZHIHU_DB);
      return this.db;
    } catch {
      logger.debug('[ZhihuBackend] ZhihuDatabase not available');
      return null;
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const db = this.getDB();
    if (!db) return errorResponse('Zhihu database not available', 503);

    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    // GET /api/zhihu/contents
    if (subPath === '/contents') {
      return this.handleContents(db, new URL(req.url));
    }

    // GET /api/zhihu/feed
    if (subPath === '/feed') {
      return this.handleFeed(db, new URL(req.url));
    }

    // GET /api/zhihu/stats
    if (subPath === '/stats') {
      return this.handleStats(db);
    }

    // GET /api/zhihu/content/:targetType/:targetId
    const contentMatch = subPath.match(/^\/content\/(article|answer)\/(\d+)$/);
    if (contentMatch?.[1] && contentMatch[2]) {
      return this.handleGetContent(db, contentMatch[1], Number(contentMatch[2]));
    }

    return errorResponse('Not found', 404);
  }

  private handleContents(db: ZhihuDatabase, url: URL): Response {
    try {
      const targetType = url.searchParams.get('type') || undefined;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
      const sinceTs = url.searchParams.has('sinceTs') ? Number(url.searchParams.get('sinceTs')) : undefined;
      const keyword = url.searchParams.get('keyword') || undefined;

      let rows: ZhihuContentRow[];
      if (keyword) {
        rows = db.searchContents(keyword, limit);
        if (targetType) {
          rows = rows.filter((r) => r.targetType === targetType);
        }
      } else if (sinceTs) {
        rows = db.getContentsSince(sinceTs, limit, targetType);
      } else {
        rows = db.getRecentContents(limit, targetType);
      }

      return jsonResponse({ contents: rows.map(rowToListItem) });
    } catch (err) {
      logger.error('[ZhihuBackend] contents error:', err);
      return errorResponse('Failed to list contents', 500);
    }
  }

  private handleGetContent(db: ZhihuDatabase, targetType: string, targetId: number): Response {
    try {
      const row = db.getContent(targetType, targetId);
      if (!row) return errorResponse('Content not found', 404);
      return jsonResponse({ content: rowToDetail(row) });
    } catch (err) {
      logger.error('[ZhihuBackend] get content error:', err);
      return errorResponse('Failed to get content', 500);
    }
  }

  private handleFeed(db: ZhihuDatabase, url: URL): Response {
    try {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
      const verb = url.searchParams.get('verb') || undefined;
      const rows = db.getRecentItems(limit, verb);
      return jsonResponse({ items: rows.map((r) => feedRowToListItem(r, db)) });
    } catch (err) {
      logger.error('[ZhihuBackend] feed error:', err);
      return errorResponse('Failed to list feed', 500);
    }
  }

  private handleStats(db: ZhihuDatabase): Response {
    try {
      const totalFeedItems = db.getTotalCount();
      const contentsByType = db.getContentStats();
      const totalContents = contentsByType.reduce((sum, s) => sum + s.count, 0);
      const feedByVerb = db.getCountByVerb().map((v) => ({
        verb: v.verb,
        verbLabel: getVerbLabel(v.verb),
        count: v.count,
      }));
      const lastFetchTs = db.getLastFetchTimestamp();

      return jsonResponse({
        stats: {
          totalFeedItems,
          totalContents,
          contentsByType,
          feedByVerb,
          lastFetchTs,
        } satisfies ZhihuPageStats,
      });
    } catch (err) {
      logger.error('[ZhihuBackend] stats error:', err);
      return errorResponse('Failed to get stats', 500);
    }
  }
}
