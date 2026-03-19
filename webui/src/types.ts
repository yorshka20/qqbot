export interface FileItem {
  name: string
  path: string
  isDir: boolean
  size?: number
  mtime?: number
}

export interface ListResponse {
  items: FileItem[]
}

// ────────────────────────────────────────────────────────────────────────────
// Report Types
// ────────────────────────────────────────────────────────────────────────────

export interface ReportListItem {
  id: string
  type: string
  title: string
  generatedAt: string
  period: string
  stats: {
    totalMessages: number
    totalArticles: number
    groupCount: number
  }
}

export interface ReportListResponse {
  reports: ReportListItem[]
}

export interface GroupSummary {
  conversationId: string
  messageCount: number
  senderCount: number
  senders: string[]
  formattedMessages: string
  categories: string[]
}

export interface ArticleSummary {
  title: string
  url: string
  summary: string
  source: string
  accountNick: string
  sourceType: string
  sharedBy?: string
  sharedIn?: string
  pubTime: number
}

export interface WechatStats {
  period: string
  sinceTs: number
  messages: {
    total: number
    groups: number
    private: number
    groupCount: number
    privateCount: number
  }
  articles: {
    total: number
    oaPush: number
    shared: number
  }
  topGroups: Array<{
    conversationId: string
    messageCount: number
    senderCount: number
  }>
  topAccounts: Array<{
    accountNick: string
    articleCount: number
  }>
}

export interface StructuredReport {
  id: string
  type: string
  title: string
  generatedAt: string
  period: {
    start: string
    end: string
    label: string
  }
  stats: WechatStats | null
  groups: GroupSummary[]
  articles: ArticleSummary[]
  markdownContent: string
}

export interface ReportMetadata {
  id: string
  type: string
  generatedAt: string
  period: string
  filePath: string
  stats: {
    totalMessages: number
    totalArticles: number
    groupCount: number
  }
}

export interface ReportDetailResponse {
  report: StructuredReport
  metadata: ReportMetadata
}

// ────────────────────────────────────────────────────────────────────────────
// Insight Types (Article Analysis)
// ────────────────────────────────────────────────────────────────────────────

export interface InsightListItem {
  articleMsgId: string
  title: string
  url: string
  source: string
  headline: string
  categoryTags: string[]
  worthReporting: boolean
  analyzedAt: string
  model: string
  itemCount: number
}

export interface InsightDetail {
  articleMsgId: string
  title: string
  url: string
  source: string
  headline: string
  categoryTags: string[]
  items: Array<{
    type: string
    content: string
    tags: string[]
    importance: string
  }>
  worthReporting: boolean
  analyzedAt: string
  model: string
}

export interface InsightStats {
  total: number
  worthReporting: number
  notWorth: number
  byCategory: Array<{ tag: string; count: number }>
}

export interface InsightListResponse {
  insights: InsightListItem[]
}

export interface InsightDetailResponse {
  insight: InsightDetail
}

export interface InsightStatsResponse {
  stats: InsightStats
}

// ────────────────────────────────────────────────────────────────────────────
// Zhihu Types
// ────────────────────────────────────────────────────────────────────────────

export interface ZhihuContentListItem {
  targetType: string
  targetId: number
  title: string
  url: string
  authorName: string
  authorUrlToken: string
  authorAvatarUrl: string | null
  excerpt: string
  voteupCount: number
  commentCount: number
  questionTitle: string | null
  createdTime: number
  fetchedAt: string
}

export interface ZhihuContentDetail {
  targetType: string
  targetId: number
  title: string
  url: string
  authorName: string
  authorUrlToken: string
  authorAvatarUrl: string | null
  content: string
  excerpt: string
  voteupCount: number
  commentCount: number
  questionId: number | null
  questionTitle: string | null
  createdTime: number
  fetchedAt: string
}

export interface ZhihuPageStats {
  totalFeedItems: number
  totalContents: number
  contentsByType: Array<{ targetType: string; count: number }>
  feedByVerb: Array<{ verb: string; verbLabel: string; count: number }>
  lastFetchTs: number
}

export interface ZhihuContentsResponse {
  contents: ZhihuContentListItem[]
}

export interface ZhihuContentDetailResponse {
  content: ZhihuContentDetail
}

export interface ZhihuStatsResponse {
  stats: ZhihuPageStats
}

// ────────────────────────────────────────────────────────────────────────────
// Moments Types (WeChat 朋友圈)
// ────────────────────────────────────────────────────────────────────────────

export interface MomentItem {
  id: string | number
  content: string
  createTime: string
  type: string
  mediasCount: number
  tags: string[]
  summary: string
  score?: number
}

export interface TagCount {
  tag: string
  count: number
}

export interface TimelineEntry {
  month: string
  count: number
}

export interface MomentsStats {
  total: number
  tagged: number
  untagged: number
  timeRange: { earliest: string; latest: string } | null
  topTags: TagCount[]
  monthlyCount: TimelineEntry[]
}

export interface MomentsStatsResponse {
  stats: MomentsStats
}

export interface MomentsListResponse {
  moments: MomentItem[]
  total: number
  nextOffset: string | number | null
}

export interface MomentsSearchResponse {
  moments: MomentItem[]
  query: string
}
