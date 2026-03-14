// WeChatPadPro HTTP API client — read-only subset only

import { logger } from '@/utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Generic response wrapper
// ────────────────────────────────────────────────────────────────────────────

interface PadProResponse<T = unknown> {
  Code?: number;
  code?: number;
  Data?: T;
  data?: T;
  Msg?: string;
  msg?: string;
  message?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Domain types (read-only endpoints)
// ────────────────────────────────────────────────────────────────────────────

export interface WXLoginStatus {
  IsOnline?: boolean;
  Status?: number;
  WxId?: string;
  WxNickName?: string;
  HeadUrl?: string;
}

export interface WXProfile {
  UserName?: string;
  NickName?: string;
  Sex?: number;
  Province?: string;
  City?: string;
  Signature?: string;
  HeadImgUrl?: string;
  Alias?: string;
}

export interface WXContact {
  UserName?: string;
  NickName?: string;
  Remark?: string;
  HeadImgUrl?: string;
  Sex?: number;
  Province?: string;
  City?: string;
}

export interface WXGroup {
  ChatRoomName?: string;
  NickName?: string;
  MemberCount?: number;
  HeadImgUrl?: string;
}

export interface WXGroupMember {
  UserName?: string;
  NickName?: string;
  DisplayName?: string;
  HeadImgUrl?: string;
}

export interface WXGroupInfo {
  ChatRoomName?: string;
  NickName?: string;
  MemberCount?: number;
  Announcement?: string;
  Owner?: string;
  MemberList?: WXGroupMember[];
}

export interface WXMoment {
  id?: string;
  userName?: string;
  nickName?: string;
  content?: string;
  createTime?: number;
  mediaList?: Array<{ url?: string; type?: number }>;
  likeCount?: number;
  commentCount?: number;
}

export interface WXHistoryMessage {
  MsgId?: number;
  NewMsgId?: number;
  MsgType?: number;
  Content?: string;
  FromUserName?: string;
  ToUserName?: string;
  CreateTime?: number;
}

export interface WXOfficialAccount {
  UserName?: string;
  NickName?: string;
  HeadImgUrl?: string;
  Signature?: string;
}

export interface WXSearchResult {
  UserName?: string;
  NickName?: string;
  Province?: string;
  City?: string;
  Sex?: number;
  HeadImgUrl?: string;
  Signature?: string;
  Alias?: string;
}

export interface WXFavorite {
  FavId?: number;
  Title?: string;
  Desc?: string;
  Type?: number;
  CreateTime?: number;
  UpdateTime?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

export class WeChatPadProClient {
  private readonly base: string;
  private readonly authKey: string;
  private readonly timeout: number;

  constructor(opts: { apiBase: string; authKey: string; timeoutMs?: number }) {
    this.base = opts.apiBase.replace(/\/$/, '');
    this.authKey = opts.authKey;
    this.timeout = opts.timeoutMs ?? 15_000;
  }

  // ──────────────────────────────────────────────────
  // Login / Status
  // ──────────────────────────────────────────────────

  async getLoginStatus(): Promise<WXLoginStatus> {
    const raw = await this.get<PadProResponse<WXLoginStatus>>('/login/GetLoginStatus');
    return (raw?.Data ?? raw?.data ?? raw) as WXLoginStatus;
  }

  // ──────────────────────────────────────────────────
  // User profile
  // ──────────────────────────────────────────────────

  async getProfile(): Promise<WXProfile> {
    const raw = await this.get<PadProResponse<WXProfile>>('/user/GetProfile');
    return (raw?.Data ?? raw?.data ?? raw) as WXProfile;
  }

  // ──────────────────────────────────────────────────
  // Contacts
  // ──────────────────────────────────────────────────

  async getFriendList(): Promise<WXContact[]> {
    const raw =
      await this.get<PadProResponse<WXContact[] | { List?: WXContact[]; list?: WXContact[] }>>('/friend/GetFriendList');
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).List ?? (data as any).list;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  async getOfficialAccountList(): Promise<WXOfficialAccount[]> {
    const raw =
      await this.get<PadProResponse<WXOfficialAccount[] | { List?: WXOfficialAccount[] }>>('/friend/GetGHList');
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).List ?? (data as any).list;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  /** Search contact by wxid / phone / QQ number */
  async searchContact(query: string): Promise<WXSearchResult | null> {
    const raw = await this.post<PadProResponse<WXSearchResult>>('/friend/SearchContact', {
      UserName: query,
      SearchScene: 3,
      OpCode: 1,
      FromScene: 3,
    });
    return (raw?.Data ?? raw?.data ?? null) as WXSearchResult | null;
  }

  /** Get detailed info for one or more contacts/groups */
  async getContactDetailsList(wxids: string[]): Promise<WXContact[]> {
    const raw = await this.post<PadProResponse<WXContact[] | { ContactList?: WXContact[] }>>(
      '/friend/GetContactDetailsList',
      {
        UserNames: wxids,
      },
    );
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).ContactList ?? (data as any).contactList;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  // ──────────────────────────────────────────────────
  // Groups
  // ──────────────────────────────────────────────────

  /** All groups including non-bookmarked ones */
  async getAllGroupList(): Promise<WXGroup[]> {
    const raw = await this.get<PadProResponse<WXGroup[] | { ChatRoomList?: WXGroup[] }>>('/group/GetAllGroupList');
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).ChatRoomList ?? (data as any).chatRoomList ?? (data as any).List ?? (data as any).list;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  /** Get details for specific groups */
  async getChatRoomInfo(groupIds: string[]): Promise<WXGroupInfo[]> {
    const raw = await this.post<PadProResponse<WXGroupInfo[] | { ChatRoomList?: WXGroupInfo[] }>>(
      '/group/GetChatRoomInfo',
      {
        ChatRoomWxIdList: groupIds,
      },
    );
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).ChatRoomList ?? (data as any).chatRoomList;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  /** Get members of a group — groupId must include @chatroom suffix */
  async getChatroomMemberDetail(groupId: string): Promise<WXGroupMember[]> {
    // Ensure @chatroom suffix
    const chatRoomName = groupId.endsWith('@chatroom') ? groupId : `${groupId}@chatroom`;
    const raw = await this.post<
      PadProResponse<{ MemberList?: WXGroupMember[]; memberList?: WXGroupMember[] } | WXGroupMember[]>
    >('/group/GetChatroomMemberDetail', { ChatRoomName: chatRoomName });
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).MemberList ?? (data as any).memberList;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  // ──────────────────────────────────────────────────
  // Moments (SNS)
  // ──────────────────────────────────────────────────

  /** Get own moments timeline. Pass maxId from last result to paginate. */
  async getMomentsTimeline(maxId?: number): Promise<WXMoment[]> {
    const raw = await this.post<PadProResponse<{ ObjectList?: WXMoment[]; objectList?: WXMoment[] }>>(
      '/sns/SendSnsTimeLine',
      {
        UserName: '',
        MaxID: maxId ?? 0,
        FirstPageMD5: '',
      },
    );
    const data = raw?.Data ?? raw?.data;
    if (data && typeof data === 'object') {
      const list = (data as any).ObjectList ?? (data as any).objectList ?? (data as any).List ?? (data as any).list;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  /** Get a specific person's moments */
  async getUserMoments(wxid: string, maxId?: number): Promise<WXMoment[]> {
    const raw = await this.post<PadProResponse<{ ObjectList?: WXMoment[] }>>('/sns/SendSnsUserPage', {
      UserName: wxid,
      MaxID: maxId ?? 0,
      FirstPageMD5: '',
    });
    const data = raw?.Data ?? raw?.data;
    if (data && typeof data === 'object') {
      const list = (data as any).ObjectList ?? (data as any).objectList;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  // ──────────────────────────────────────────────────
  // Message history
  // ──────────────────────────────────────────────────

  /** Sync recent messages via HTTP polling (read-only). count=0 means all buffered. */
  async syncMessages(count = 20): Promise<WXHistoryMessage[]> {
    const raw = await this.post<PadProResponse<WXHistoryMessage[] | { List?: WXHistoryMessage[] }>>(
      '/message/HttpSyncMsg',
      {
        Count: count,
      },
    );
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).List ?? (data as any).list;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  // ──────────────────────────────────────────────────
  // Favorites
  // ──────────────────────────────────────────────────

  async getFavoriteList(favId = 0): Promise<WXFavorite[]> {
    const raw = await this.post<PadProResponse<WXFavorite[] | { FavItemList?: WXFavorite[] }>>('/favor/GetFavList', {
      FavId: favId,
      KeyBuf: '',
    });
    const data = raw?.Data ?? raw?.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const list = (data as any).FavItemList ?? (data as any).favItemList ?? (data as any).List;
      if (Array.isArray(list)) return list;
    }
    return [];
  }

  // ──────────────────────────────────────────────────
  // HTTP helpers
  // ──────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.base}${path}?key=${encodeURIComponent(this.authKey)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });
    if (!resp.ok) {
      throw new Error(`WeChatPadPro GET ${path} → HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as T;
    logger.debug(`[WeChatPadProClient] GET ${path} → ${resp.status}`);
    return json;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.base}${path}?key=${encodeURIComponent(this.authKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) {
      throw new Error(`WeChatPadPro POST ${path} → HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as T;
    logger.debug(`[WeChatPadProClient] POST ${path} → ${resp.status}`);
    return json;
  }
}
