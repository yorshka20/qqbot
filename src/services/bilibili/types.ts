// Bilibili API type definitions

/** Standard bilibili API response wrapper */
export interface BilibiliAPIResponse<T> {
  code: number;
  message: string;
  ttl?: number;
  data: T;
}

/** Video item from various endpoints */
export interface BilibiliVideoItem {
  bvid: string;
  aid?: number;
  title: string;
  desc?: string;
  pic: string;
  owner: {
    mid: number;
    name: string;
    face: string;
  };
  stat: {
    view: number;
    danmaku: number;
    reply: number;
    favorite: number;
    coin: number;
    like: number;
    share?: number;
  };
  duration: number;
  pubdate?: number;
  cid?: number;
  pages?: Array<{
    cid: number;
    page: number;
    part: string;
    duration: number;
  }>;
  /** Present in recommended feed */
  goto?: string;
  /** Present in recommended feed */
  id?: number;
}

/** Search result item */
export interface BilibiliSearchItem {
  bvid: string;
  aid: number;
  title: string;
  description: string;
  pic: string;
  mid: number;
  author: string;
  play: number;
  video_review: number;
  review: number;
  duration: string;
  pubdate: number;
}

/** Search response data */
export interface BilibiliSearchData {
  numResults: number;
  numPages: number;
  page: number;
  pagesize: number;
  result: BilibiliSearchItem[];
}

/** Hot search response (existing API) */
export interface BilibiliHotSearchResponse {
  code: number;
  list?: Array<{
    keyword: string;
    show_name: string;
    heat_score: number;
    pos: number;
    icon?: string;
  }>;
}

/** Popular videos response data */
export interface BilibiliPopularData {
  list: BilibiliVideoItem[];
  no_more: boolean;
}

/** Nav info (also provides WBI keys) */
export interface BilibiliNavData {
  isLogin: boolean;
  face?: string;
  uname?: string;
  mid?: number;
  wbi_img: {
    img_url: string;
    sub_url: string;
  };
}

/** Comment item */
export interface BilibiliComment {
  rpid: number;
  content: {
    message: string;
  };
  member: {
    uname: string;
    avatar: string;
    mid: string;
  };
  like: number;
  ctime: number;
  replies?: BilibiliComment[];
}

/** Comment response data */
export interface BilibiliCommentData {
  replies: BilibiliComment[] | null;
  cursor: {
    all_count: number;
    is_end: boolean;
    next: number;
  };
}

// ── Video Knowledge Backend types ──

/** Task status from video-knowledge-backend */
export type VideoKnowledgeTaskStatus = 'queued' | 'claimed' | 'done' | 'failed';

/** POST /api/v1/analyze request body */
export interface VideoKnowledgeAnalyzeRequest {
  platform: string;
  video_id: string;
}

/** POST /api/v1/analyze response (202) */
export interface VideoKnowledgeAnalyzeResponse {
  task_id: number;
}

/** POST /api/v1/ingest request body */
export interface VideoKnowledgeIngestRequest {
  platform: string;
  video_id: string;
  source?: string;
  video_info?: {
    title: string;
    duration: number;
    creator: string;
    desc?: string;
  };
  subtitles?: Array<{
    from: number;
    to: number;
    content: string;
    lang?: string;
  }>;
  overlays?: Array<{
    progress_ms: number;
    content: string;
    posted_at?: number;
  }>;
}

/** POST /api/v1/ingest response (200) */
export interface VideoKnowledgeIngestResponse {
  video_id: string;
  accepted: string[];
  task_id: number;
}

/** GET /api/v1/tasks/{id} response */
export interface VideoKnowledgeTask {
  id: number;
  type: string;
  status: VideoKnowledgeTaskStatus;
  priority: number;
  retry_count: number;
  error_msg?: string;
  created_at: string;
  claimed_at?: string;
  done_at?: string;
}

/** Analysis result JSON structure (read from local filesystem) */
export interface VideoKnowledgeResult {
  video_info: {
    platform: string;
    video_id: string;
    title: string;
    duration: number;
    creator: {
      platform: string;
      id: string;
      name: string;
    };
    stats?: {
      view_count: number;
      like_count: number;
      comment_count: number;
      danmaku_count: number;
    };
  };
  summary?: string;
  highlights?: Array<{
    start_sec: number;
    end_sec: number;
    title: string;
    description: string;
    reason?: string;
  }>;
  peaks?: Array<{
    start_sec: number;
    end_sec: number;
    count: number;
    density: number;
    peak_rank: number;
    subtitle_text?: string;
    top_overlays?: string[];
  }>;
  data_sources?: string[];
  processed_at?: string;
}

/** Poll result wrapper */
export interface VideoKnowledgePollResult {
  success: boolean;
  error?: string;
  task?: VideoKnowledgeTask;
}
