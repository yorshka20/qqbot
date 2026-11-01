// `/api/zhihu` — Zhihu feed browsing. Every route reads the `feed_items` table;
// full article bodies are no longer fetched, so `questionTitle` is always null.

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

/** `GET /api/zhihu/contents` */
export interface ZhihuContentsResponse {
  contents: ZhihuContentListItem[];
}

/** `GET /api/zhihu/feed` */
export interface ZhihuFeedResponse {
  items: ZhihuFeedListItem[];
}

/** `GET /api/zhihu/stats` */
export interface ZhihuStatsResponse {
  stats: ZhihuPageStats;
}
