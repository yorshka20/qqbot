// `/api/reports` — stored WeChat reports.

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'custom';

export interface MessageEntry {
  time: string;
  sender: string;
  content: string;
  category: string;
  /** Set when `category` is `article`. */
  url?: string;
  /** Set when `category` is `image`. */
  filePath?: string;
  /** Set when `category` is `article`. */
  title?: string;
}

export interface GroupSummary {
  conversationId: string;
  groupName: string;
  messageCount: number;
  senderCount: number;
  senders: string[];
  formattedMessages: string;
  messages: MessageEntry[];
  categories: string[];
}

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
    groupName: string;
    messageCount: number;
    senderCount: number;
  }>;
  topAccounts: Array<{
    accountNick: string;
    articleCount: number;
  }>;
}

export interface StructuredReport {
  id: string;
  type: ReportType;
  title: string;
  generatedAt: string;
  period: {
    start: string;
    end: string;
    label: string;
  };
  stats: WechatStats | null;
  groups: GroupSummary[];
  articles: ArticleSummary[];
  markdownContent: string;
}

export interface ReportMetadata {
  id: string;
  type: ReportType;
  generatedAt: string;
  period: string;
  filePath: string;
  stats: {
    totalMessages: number;
    totalArticles: number;
    groupCount: number;
  };
}

/** One row of `GET /api/reports/list` — summary only, no report body. */
export interface ReportListItem {
  id: string;
  type: ReportType;
  title: string;
  generatedAt: string;
  period: string;
  stats: {
    totalMessages: number;
    totalArticles: number;
    groupCount: number;
  };
}

/** `GET /api/reports/list` */
export interface ReportListResponse {
  reports: ReportListItem[];
}

/** `GET /api/reports/:id` */
export interface ReportDetailResponse {
  report: StructuredReport;
  metadata: ReportMetadata;
}
