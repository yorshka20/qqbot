// Group daily report data types

/** Topic discussed in the group */
export interface ReportTopic {
  title: string;
  summary: string;
}

/** Member highlight with LLM-generated comment */
export interface MemberHighlight {
  userId: string;
  nickname: string;
  messageCount: number;
  comment: string;
}

/** Featured message with LLM evaluation */
export interface FeaturedMessage {
  userId: string;
  nickname: string;
  content: string;
  comment: string;
}

/** Hourly activity data point */
export interface HourlyActivity {
  hour: number;
  count: number;
}

/** Full group report data */
export interface GroupReportData {
  groupName: string;
  groupId: string;
  date: string;
  totalMessages: number;
  activeMembers: number;
  highlightTimeRange: string;
  hourlyActivity: HourlyActivity[];
  topics: ReportTopic[];
  memberHighlights: MemberHighlight[];
  featuredMessages: FeaturedMessage[];
  totalSummary: string;
}
