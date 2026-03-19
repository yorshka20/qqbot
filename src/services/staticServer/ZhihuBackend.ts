/**
 * Zhihu backend: REST API (/api/zhihu) for Zhihu content browsing.
 *
 * API contract:
 * - GET  /api/zhihu/contents?type=&limit=&sinceTs=&keyword=  -> { contents: ZhihuContentListItem[] }
 * - GET  /api/zhihu/feed?limit=&verb=                         -> { items: ZhihuFeedListItem[] }
 * - GET  /api/zhihu/stats                                     -> { stats: ZhihuPageStats }
 */

import { getContainer } from '@/core/DIContainer';
import { ZhihuDITokens } from '@/services/zhihu/tokens';
import type { ZhihuFeedItemRow } from '@/services/zhihu/types';
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
}

export interface ZhihuPageStats {
  totalFeedItems: number;
  feedByType: Array<{ targetType: string; count: number }>;
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

function feedRowToContentListItem(row: ZhihuFeedItemRow): ZhihuContentListItem {
  return {
    targetType: row.targetType,
    targetId: row.targetId,
    title: row.title,
    url: row.url,
    authorName: row.authorName,
    authorUrlToken: row.authorUrlToken,
    authorAvatarUrl: row.authorAvatarUrl,
    excerpt: row.excerpt,
    voteupCount: row.voteupCount,
    commentCount: row.commentCount,
    questionTitle: null,
    createdTime: row.createdTime,
    fetchedAt: row.fetchedAt,
  };
}

function feedRowToListItem(row: ZhihuFeedItemRow): ZhihuFeedListItem {
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

    return errorResponse('Not found', 404);
  }

  private handleContents(db: ZhihuDatabase, url: URL): Response {
    try {
      const targetType = url.searchParams.get('type') || undefined;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
      const sinceTs = url.searchParams.has('sinceTs') ? Number(url.searchParams.get('sinceTs')) : undefined;
      const keyword = url.searchParams.get('keyword') || undefined;

      // Read from feed_items table (no longer fetching full content)
      let rows: ZhihuFeedItemRow[];
      if (keyword) {
        rows = db.searchFeedItems(keyword, limit);
        if (targetType) {
          rows = rows.filter((r) => r.targetType === targetType);
        }
      } else if (sinceTs) {
        rows = db.getItemsSince(sinceTs, limit);
        if (targetType) {
          rows = rows.filter((r) => r.targetType === targetType);
        }
      } else {
        rows = db.getRecentItems(limit);
        if (targetType) {
          rows = rows.filter((r) => r.targetType === targetType);
        }
      }

      return jsonResponse({ contents: rows.map(feedRowToContentListItem) });
    } catch (err) {
      logger.error('[ZhihuBackend] contents error:', err);
      return errorResponse('Failed to list contents', 500);
    }
  }

  private handleFeed(db: ZhihuDatabase, url: URL): Response {
    try {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
      const verb = url.searchParams.get('verb') || undefined;
      const rows = db.getRecentItems(limit, verb);
      return jsonResponse({ items: rows.map((r) => feedRowToListItem(r)) });
    } catch (err) {
      logger.error('[ZhihuBackend] feed error:', err);
      return errorResponse('Failed to list feed', 500);
    }
  }

  private handleStats(db: ZhihuDatabase): Response {
    try {
      const totalFeedItems = db.getTotalCount();
      const feedByType = db.getFeedStatsByType();
      const feedByVerb = db.getCountByVerb().map((v) => ({
        verb: v.verb,
        verbLabel: getVerbLabel(v.verb),
        count: v.count,
      }));
      const lastFetchTs = db.getLastFetchTimestamp();

      return jsonResponse({
        stats: {
          totalFeedItems,
          feedByType,
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
