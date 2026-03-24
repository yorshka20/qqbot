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
