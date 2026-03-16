/** DI tokens scoped to the WeChat service layer. Registered by WeChatIngestPlugin. */
export const WechatDITokens = {
  EVENT_BRIDGE: 'WechatEventBridge',
  DIGEST_SERVICE: 'WechatDigestService',
  REPORT_SERVICE: 'WechatReportService',
} as const;

export type {
  MessageCategory,
  ParsedWeChatMessage,
  ResolvedWeChatIngestConfig,
  WeChatIngestConfig,
  WeChatRealtimeRule,
  WeChatWebhookMessage,
} from './types';
export { resolveConfig } from './types';
export type { WeChatGroupRow, WeChatMessageRow, WeChatOAArticleRow } from './WeChatDatabase';
export { WeChatDatabase } from './WeChatDatabase';
export type { NotifyCallback } from './WeChatIngestService';
export { WeChatIngestService } from './WeChatIngestService';
export { WeChatMessageBuffer } from './WeChatMessageBuffer';
export type {
  WXContact,
  WXFavorite,
  WXGroup,
  WXGroupInfo,
  WXGroupMember,
  WXHistoryMessage,
  WXLoginStatus,
  WXMoment,
  WXOfficialAccount,
  WXProfile,
  WXSearchResult,
} from './WeChatPadProClient';
export { WeChatPadProClient } from './WeChatPadProClient';
export type {
  ArticleSummary,
  GroupSummary,
  WechatSearchResult,
  WechatStats,
} from './WechatDigestService';
export { WechatDigestService } from './WechatDigestService';
export type { WechatEventType, WechatMessageEventData } from './WechatEventBridge';
export { WechatEventBridge } from './WechatEventBridge';
export type {
  GeneratedReport,
  ReportFile,
  ReportMetadata,
  ReportOptions,
  ReportType,
  StructuredReport,
} from './WechatReportService';
export { WechatReportService } from './WechatReportService';
