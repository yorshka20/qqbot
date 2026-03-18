/** DI tokens scoped to the Zhihu service layer. Registered by ZhihuFeedPlugin. */
export const ZhihuDITokens = {
  ZHIHU_CLIENT: 'ZhihuClient',
  ZHIHU_FEED_SERVICE: 'ZhihuFeedService',
  ZHIHU_DIGEST_SERVICE: 'ZhihuDigestService',
  ZHIHU_DB: 'ZhihuDatabase',
} as const;
