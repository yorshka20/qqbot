/** DI tokens scoped to the WeChat service layer. Registered by WeChatIngestPlugin. */
export const WechatDITokens = {
  EVENT_BRIDGE: 'WechatEventBridge',
  DIGEST_SERVICE: 'WechatDigestService',
  REPORT_SERVICE: 'WechatReportService',
  WECHAT_DB: 'WeChatDatabase',
  ARTICLE_ANALYSIS_SERVICE: 'WeChatArticleAnalysisService',
} as const;
