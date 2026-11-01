// `/api/moments` — WeChat moments browsing and analysis.

export interface MomentItem {
  id: string | number;
  content: string;
  createTime: string;
  type: string;
  mediasCount: number;
  tags: string[];
  summary: string;
  imagePaths: string[];
  /** Only set on search results. */
  score?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TimelineEntry {
  /** `YYYY-MM`. */
  month: string;
  count: number;
}

export interface MomentsStats {
  total: number;
  tagged: number;
  untagged: number;
  timeRange: { earliest: string; latest: string } | null;
  topTags: TagCount[];
  monthlyCount: TimelineEntry[];
}

/** `GET /api/moments/stats` */
export interface MomentsStatsResponse {
  stats: MomentsStats;
}

/** `GET /api/moments/list` */
export interface MomentsListResponse {
  moments: MomentItem[];
  total: number;
  nextOffset: string | number | null;
}

/** `GET /api/moments/tags` */
export interface MomentsTagsResponse {
  tags: TagCount[];
}

/** `GET /api/moments/timeline` */
export interface MomentsTimelineResponse {
  timeline: TimelineEntry[];
}

/** `GET /api/moments/search` */
export interface MomentsSearchResponse {
  moments: MomentItem[];
  query: string;
}

/** `GET /api/moments/interest-evolution` */
export interface InterestEvolutionResponse {
  heatmap: Array<{ tag: string; month: string; count: number }>;
  tags: string[];
  months: string[];
}

/** `GET /api/moments/behavior` */
export interface BehaviorResponse {
  hourDistribution: Array<{ hour: number; count: number }>;
  dayOfWeekDistribution: Array<{ day: number; label: string; count: number }>;
  monthlyFrequency: Array<{ month: string; count: number; avgGapDays: number }>;
  gapStats: { avgDays: number; medianDays: number; maxDays: number; minDays: number };
}

/** `GET /api/moments/sentiment-trend` */
export interface SentimentTrendResponse {
  trend: Array<{
    month: string;
    avgScore: number;
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    count: number;
  }>;
  overall: { avgScore: number; positive: number; negative: number; neutral: number; mixed: number; total: number };
  analyzedCount: number;
}

/** `GET /api/moments/entities` */
export interface EntitiesResponse {
  entities: Array<{ name: string; type: string; count: number }>;
  byType: Record<string, Array<{ name: string; count: number }>>;
  analyzedCount: number;
}

/** `GET /api/moments/clusters` */
export interface ClustersResponse {
  clusters: Array<{ clusterId: number; label: string; count: number }>;
  clusteredCount: number;
}
