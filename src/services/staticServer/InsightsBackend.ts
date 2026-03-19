/**
 * Insights backend: REST API (/api/insights) for WeChat article analysis results.
 *
 * API contract:
 * - GET  /api/insights/list?worthOnly=&limit=&sinceTs=  -> { insights: InsightListItem[] }
 * - GET  /api/insights/:articleMsgId                     -> { insight: InsightDetail }
 * - GET  /api/insights/stats                             -> { stats: InsightStats }
 */

import { getContainer } from '@/core/DIContainer';
import { WechatDITokens } from '@/services/wechat/tokens';
import type { WeChatArticleInsightRow, WeChatDatabase } from '@/services/wechat/WeChatDatabase';
import { logger } from '@/utils/logger';

const API_PREFIX = '/api/insights';

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface InsightListItem {
  articleMsgId: string;
  title: string;
  url: string;
  source: string;
  headline: string;
  categoryTags: string[];
  worthReporting: boolean;
  analyzedAt: string;
  model: string;
  itemCount: number;
}

export interface InsightDetail {
  articleMsgId: string;
  title: string;
  url: string;
  source: string;
  headline: string;
  categoryTags: string[];
  items: Array<{
    type: string;
    content: string;
    tags: string[];
    importance: string;
  }>;
  worthReporting: boolean;
  analyzedAt: string;
  model: string;
}

export interface InsightStats {
  total: number;
  worthReporting: number;
  notWorth: number;
  byCategory: Array<{ tag: string; count: number }>;
}

export interface InsightListResponse {
  insights: InsightListItem[];
}

export interface InsightDetailResponse {
  insight: InsightDetail;
}

export interface InsightStatsResponse {
  stats: InsightStats;
}

interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse<ErrorResponse>({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonSafe<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function rowToListItem(row: WeChatArticleInsightRow): InsightListItem {
  const items = parseJsonSafe<unknown[]>(row.items, []);
  return {
    articleMsgId: row.articleMsgId,
    title: row.title,
    url: row.url,
    source: row.source,
    headline: row.headline,
    categoryTags: parseJsonSafe<string[]>(row.categoryTags, []),
    worthReporting: row.worthReporting === 1,
    analyzedAt: row.analyzedAt,
    model: row.model,
    itemCount: items.length,
  };
}

function rowToDetail(row: WeChatArticleInsightRow): InsightDetail {
  return {
    articleMsgId: row.articleMsgId,
    title: row.title,
    url: row.url,
    source: row.source,
    headline: row.headline,
    categoryTags: parseJsonSafe<string[]>(row.categoryTags, []),
    items: parseJsonSafe(row.items, []),
    worthReporting: row.worthReporting === 1,
    analyzedAt: row.analyzedAt,
    model: row.model,
  };
}

// ---------------------------------------------------------------------------
// InsightsBackend
// ---------------------------------------------------------------------------

export class InsightsBackend {
  private db: WeChatDatabase | null = null;

  private getDB(): WeChatDatabase | null {
    if (this.db) return this.db;
    try {
      const container = getContainer();
      this.db = container.resolve<WeChatDatabase>(WechatDITokens.WECHAT_DB);
      return this.db;
    } catch {
      logger.debug('[InsightsBackend] WeChatDatabase not available');
      return null;
    }
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;

    const db = this.getDB();
    if (!db) return errorResponse('WeChat database not available', 503);

    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method !== 'GET') return errorResponse('Method not allowed', 405);

    // GET /api/insights/list
    if (subPath === '/list') {
      return this.handleList(db, new URL(req.url));
    }

    // GET /api/insights/stats
    if (subPath === '/stats') {
      return this.handleStats(db);
    }

    // GET /api/insights/:articleMsgId
    const idMatch = subPath.match(/^\/([^/]+)$/);
    if (idMatch?.[1]) {
      return this.handleGetById(db, decodeURIComponent(idMatch[1]));
    }

    return errorResponse('Not found', 404);
  }

  private handleList(db: WeChatDatabase, url: URL): Response {
    try {
      const worthOnly = url.searchParams.get('worthOnly') !== 'false';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000);
      const sinceTs = url.searchParams.has('sinceTs') ? Number(url.searchParams.get('sinceTs')) : undefined;

      const rows = db.getArticleInsights({ worthOnly, limit, sinceTs });
      const insights = rows.map(rowToListItem);

      return jsonResponse<InsightListResponse>({ insights });
    } catch (err) {
      logger.error('[InsightsBackend] list error:', err);
      return errorResponse('Failed to list insights', 500);
    }
  }

  private handleGetById(db: WeChatDatabase, articleMsgId: string): Response {
    try {
      const row = db.getArticleInsightById(articleMsgId);
      if (!row) return errorResponse('Insight not found', 404);

      return jsonResponse<InsightDetailResponse>({ insight: rowToDetail(row) });
    } catch (err) {
      logger.error('[InsightsBackend] get error:', err);
      return errorResponse('Failed to get insight', 500);
    }
  }

  private handleStats(db: WeChatDatabase): Response {
    try {
      const all = db.getArticleInsights({ worthOnly: false, limit: 10000 });
      const worthReporting = all.filter((r) => r.worthReporting === 1).length;

      // Aggregate category tags
      const tagCounts = new Map<string, number>();
      for (const row of all) {
        const tags = parseJsonSafe<string[]>(row.categoryTags, []);
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
      const byCategory = [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);

      return jsonResponse<InsightStatsResponse>({
        stats: {
          total: all.length,
          worthReporting,
          notWorth: all.length - worthReporting,
          byCategory,
        },
      });
    } catch (err) {
      logger.error('[InsightsBackend] stats error:', err);
      return errorResponse('Failed to get stats', 500);
    }
  }
}
