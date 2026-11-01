// `/api/stats` — per-day activity rollup read back out of the log files.

export interface ErrorEntry {
  timestamp: string;
  component: string;
  message: string;
}

export interface ProviderStats {
  provider: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptChars: number;
  responseChars: number;
}

export interface HourlyActivity {
  hour: number;
  messagesReceived: number;
  messagesSent: number;
  llmCalls: number;
}

export interface GroupActivity {
  groupName: string;
  groupId: string;
  messageCount: number;
}

export interface DailyStats {
  date: string;
  summary: {
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalLLMCalls: number;
    totalErrors: number;
    totalWarnings: number;
    totalTokensUsed: number;
    totalPromptChars: number;
    totalResponseChars: number;
  };
  providerStats: ProviderStats[];
  hourlyActivity: HourlyActivity[];
  topGroups: GroupActivity[];
  recentErrors: ErrorEntry[];
  logFileCount: number;
}

/** `GET /api/stats` */
export interface DailyStatsResponse {
  stats: DailyStats;
}

/** `GET /api/stats/dates` */
export interface StatsDateListResponse {
  dates: string[];
}
