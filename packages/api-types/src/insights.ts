// `/api/insights` — WeChat article analysis results.

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

/** `GET /api/insights/list` */
export interface InsightListResponse {
  insights: InsightListItem[];
}

/** `GET /api/insights/:articleMsgId` */
export interface InsightDetailResponse {
  insight: InsightDetail;
}

/** `GET /api/insights/stats` */
export interface InsightStatsResponse {
  stats: InsightStats;
}
