// ────────────────────────────────────────────────────────────────────────────
// Zhihu API response types
// ────────────────────────────────────────────────────────────────────────────

export interface ZhihuMomentsResponse {
  data: ZhihuFeedItem[];
  paging: {
    is_end: boolean;
    next: string;
    previous: string;
  };
}

export interface ZhihuFeedItem {
  type: string;
  verb: string;
  target: {
    type: string;
    id: number;
    title?: string;
    question?: { id: number; title: string };
    content?: string;
    excerpt?: string;
    voteup_count?: number;
    comment_count?: number;
    created_time: number;
    updated_time: number;
    author?: ZhihuAuthor;
  };
  actors: ZhihuActor[];
  created_time: number;
  id: string;
  group_text?: string;
  list?: ZhihuFeedItem[];
}

export interface ZhihuAuthor {
  id: string;
  name: string;
  url_token: string;
  headline?: string;
  avatar_url?: string;
}

export interface ZhihuActor {
  id: string;
  name: string;
  avatar_url: string;
  url_token: string;
}

export interface ZhihuUser {
  id: string;
  name: string;
  url_token: string;
  headline?: string;
  avatar_url?: string;
}

export interface ZhihuAnswer {
  id: number;
  content: string;
  question: { id: number; title: string };
  author: ZhihuAuthor;
  voteup_count: number;
  comment_count: number;
  created_time: number;
  updated_time: number;
}

export interface ZhihuArticle {
  id: number;
  title: string;
  content: string;
  author: ZhihuAuthor;
  voteup_count: number;
  comment_count: number;
  created: number;
  updated: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Parsed content item (unified structure stored in DB)
// ────────────────────────────────────────────────────────────────────────────

export interface ZhihuContentItem {
  id: string; // unique: `${verb}:${target.type}:${target.id}`
  feedId: string; // original feed item id
  verb: string;
  targetType: string;
  targetId: number;
  title: string;
  excerpt: string;
  content?: string;
  url: string;
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl?: string;
  voteupCount: number;
  commentCount: number;
  actorNames: string[];
  createdTime: number; // unix timestamp (seconds)
  fetchedAt: string; // ISO datetime
}

// ────────────────────────────────────────────────────────────────────────────
// Database row type
// ────────────────────────────────────────────────────────────────────────────

export interface ZhihuFeedItemRow {
  id: string;
  feedId: string;
  verb: string;
  targetType: string;
  targetId: number;
  title: string;
  excerpt: string;
  content: string | null;
  url: string;
  authorName: string;
  authorUrlToken: string;
  authorAvatarUrl: string | null;
  voteupCount: number;
  commentCount: number;
  actorNames: string; // JSON array
  createdTime: number;
  fetchedAt: string;
  digestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────

export interface ZhihuConfig {
  enabled?: boolean;
  cookie: string;
  pollIntervalCron?: string; // default "*/30 * * * *"
  digestCron?: string; // default "0 9,21 * * *"
  digestGroupIds?: string[];
  requestIntervalMs?: number; // default 2000
  maxPagesPerPoll?: number; // default 5
  digestHoursBack?: number; // default 12
  digestProvider?: string; // default "deepseek"
  topItemsToEnrich?: number; // default 3
  verbFilter?: string[];
}

export const DEFAULT_ZHIHU_CONFIG = {
  pollIntervalCron: '*/30 * * * *',
  digestCron: '0 9,21 * * *',
  digestGroupIds: [] as string[],
  requestIntervalMs: 2000,
  maxPagesPerPoll: 5,
  digestHoursBack: 12,
  digestProvider: 'deepseek',
  topItemsToEnrich: 3,
  verbFilter: [
    'ANSWER_CREATE',
    'ARTICLE_CREATE',
    'ANSWER_VOTE_UP',
    'MEMBER_VOTEUP_ANSWER',
    'MEMBER_VOTEUP_ARTICLE',
    'MEMBER_ANSWER_QUESTION',
    'ZVIDEO_CREATE',
    'MEMBER_FOLLOW_QUESTION',
    'QUESTION_FOLLOW',
  ],
} as const;
