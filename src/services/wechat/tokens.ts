/** DI tokens scoped to the WeChat service layer. Registered by WeChatIngestPlugin. */
export const WechatDITokens = {
  EVENT_BRIDGE: 'WechatEventBridge',
  DIGEST_SERVICE: 'WechatDigestService',
  REPORT_SERVICE: 'WechatReportService',
} as const;
