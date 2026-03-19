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
