// WeChatPadPro HTTP API client — read-only subset only

import { logger } from '@/utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Generic response envelope
// ────────────────────────────────────────────────────────────────────────────

interface PadProEnvelope<T> {
  Code?: number;
  Data?: T;
  Text?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Raw response shapes (internal — match what the API actually returns)
// ────────────────────────────────────────────────────────────────────────────

/** PadPro wraps most string fields as { str: "..." } */
interface StrWrapper {
  str?: string;
}

interface RawLoginStatusData {
  loginState: number; // 1 = online
  loginErrMsg: string;
  loginTime: string;
  onlineDays: number;
  onlineTime: string;
  totalOnline: string;
  expiryTime: string;
  proxyUrl: string;
  targetIp: string;
  loginJournal: { count: number; logs: string[] };
}

interface RawUserInfo {
  userName: StrWrapper;
  nickName: StrWrapper;
  bindEmail: StrWrapper;
  bindMobile: StrWrapper;
  sex: number;
  province: string;
  city: string;
  signature: string;
  bitFlag?: number;
  status?: number;
}

interface RawUserInfoExt {
  alias?: StrWrapper;
  snsUserInfo?: Record<string, unknown>;
}

interface RawProfileData {
  baseResponse: { ret: number };
  userInfo: RawUserInfo;
  userInfoExt: RawUserInfoExt;
}

interface RawContact {
  userName: StrWrapper;
  nickName: StrWrapper;
  remark: StrWrapper | Record<string, never>;
  sex: number;
  province: string;
  city: string;
  signature: string;
}

interface RawFriendListData {
  IsInitFinished: boolean;
  count: number;
  friendList: RawContact[];
}

interface RawGhListData {
  GhList: RawContact[];
}

interface RawSearchResultData {
  UserName?: StrWrapper | string;
  NickName?: StrWrapper | string;
  Province?: string;
  City?: string;
  Sex?: number;
  HeadImgUrl?: string;
  Signature?: string;
  Alias?: StrWrapper | string;
}

interface RawGroupListData {
  ChatRoomList?: RawGroupItem[];
  chatRoomList?: RawGroupItem[];
}

interface RawGroupItem {
  ChatRoomName?: StrWrapper | string;
  NickName?: StrWrapper | string;
  MemberCount?: number;
  HeadImgUrl?: string;
}

interface RawGroupInfoData {
  ChatRoomInfoList?: RawGroupInfoItem[];
  chatRoomList?: RawGroupInfoItem[];
  contactList?: RawGroupInfoItem[];
}

interface RawGroupInfoItem {
  chatroomUsername?: StrWrapper | string;
  userName?: StrWrapper | string;
  nickName?: StrWrapper | string;
  memberCount?: number;
  announcement?: StrWrapper | string;
  chatroomOwner?: StrWrapper | string;
  chatRoomOwner?: string;
  memberList?: RawGroupMemberItem[];
  newChatroomData?: { member_count?: number; chatroom_member_list?: RawGroupMemberItem[] };
}

interface RawGroupMemberItem {
  userName?: StrWrapper | string;
  nickName?: StrWrapper | string;
  displayName?: StrWrapper | string;
  // snake_case variants from newChatroomData format
  user_name?: string;
  nick_name?: string;
  display_name?: string;
}

interface RawMomentsData {
  baseResponse: { ret: number };
  objectCount: number;
  objectList: RawMomentItem[];
  firstPageMd5?: string;
}

interface RawMomentItem {
  id: number | string;
  username: string;
  nickname: string;
  createTime: number;
  likeCount?: number;
  commentCount?: number;
  objectDesc?: { len: number; buffer?: string };
}

interface RawFavListData {
  Ret: number;
  List: RawFavItem[];
}

interface RawFavItem {
  favId: number;
  type: number;
  flag: number;
  updateTime: number;
  updateSeq?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Public exported types (clean, PascalCase)
// ────────────────────────────────────────────────────────────────────────────

export interface WXLoginStatus {
  /** 1 = online */
  loginState?: number;
  loginErrMsg?: string;
  loginTime?: string;
  onlineTime?: string;
  totalOnline?: string;
  expiryTime?: string;
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
  Sex?: number;
  Province?: string;
  City?: string;
}

export interface WXGroup {
  ChatRoomName?: string;
  NickName?: string;
  MemberCount?: number;
}

export interface WXGroupMember {
  UserName?: string;
  NickName?: string;
  DisplayName?: string;
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
  createTime?: number;
  likeCount?: number;
  commentCount?: number;
  /** Base64-encoded XML describing moment content (text + media). */
  objectDescBuffer?: string;
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
}

export interface WXSearchResult {
  UserName?: string;
  NickName?: string;
  Province?: string;
  City?: string;
  Sex?: number;
  Signature?: string;
  Alias?: string;
}

export interface WXFavorite {
  FavId?: number;
  Type?: number;
  UpdateTime?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

export class WeChatPadProClient {
  private readonly base: string;
  private readonly authKey: string;
  private readonly timeout: number;
  /** Own wxid, if provided at construction time. */
  readonly wxid: string | undefined;

  constructor(opts: { apiBase: string; authKey: string; wxid?: string; timeoutMs?: number }) {
    this.base = opts.apiBase.replace(/\/$/, '');
    this.authKey = opts.authKey;
    this.wxid = opts.wxid;
    this.timeout = opts.timeoutMs ?? 15_000;
  }

  // ──────────────────────────────────────────────────
  // Login / Status
  // ──────────────────────────────────────────────────

  async getLoginStatus(): Promise<WXLoginStatus> {
    const env = await this.get<PadProEnvelope<RawLoginStatusData>>('/login/GetLoginStatus');
    const d = env.Data;
    if (!d) return {};
    return {
      loginState: d.loginState,
      loginErrMsg: d.loginErrMsg,
      loginTime: d.loginTime,
      onlineTime: d.onlineTime,
      totalOnline: d.totalOnline,
      expiryTime: d.expiryTime,
    };
  }

  // ──────────────────────────────────────────────────
  // User profile
  // ──────────────────────────────────────────────────

  async getProfile(): Promise<WXProfile> {
    const env = await this.get<PadProEnvelope<RawProfileData>>('/user/GetProfile');
    const d = env.Data;
    if (!d) return {};
    const u = d.userInfo;
    const ext = d.userInfoExt;
    return {
      UserName: strField(u.userName),
      NickName: strField(u.nickName),
      Sex: u.sex,
      Province: u.province || undefined,
      City: u.city || undefined,
      Signature: u.signature || undefined,
      Alias: strField(ext.alias),
    };
  }

  // ──────────────────────────────────────────────────
  // Contacts
  // ──────────────────────────────────────────────────

  async getFriendList(): Promise<WXContact[]> {
    const env = await this.get<PadProEnvelope<RawFriendListData>>('/friend/GetFriendList');
    return (env.Data?.friendList ?? []).map(mapContact);
  }

  async getOfficialAccountList(): Promise<WXOfficialAccount[]> {
    const env = await this.get<PadProEnvelope<RawGhListData>>('/friend/GetGHList');
    return (env.Data?.GhList ?? []).map((c) => ({
      UserName: strField(c.userName),
      NickName: strField(c.nickName),
    }));
  }

  /** Search contact by wxid / phone / QQ number */
  async searchContact(query: string): Promise<WXSearchResult | null> {
    const env = await this.post<PadProEnvelope<RawSearchResultData>>('/friend/SearchContact', {
      UserName: query,
      SearchScene: 3,
      OpCode: 1,
      FromScene: 3,
    });
    const d = env.Data;
    if (!d) return null;
    return {
      UserName: strFieldOrStr(d.UserName),
      NickName: strFieldOrStr(d.NickName),
      Province: d.Province,
      City: d.City,
      Sex: d.Sex,
      Signature: d.Signature,
      Alias: strFieldOrStr(d.Alias),
    };
  }

  // ──────────────────────────────────────────────────
  // Groups
  // ──────────────────────────────────────────────────

  /** All groups including non-bookmarked ones */
  async getAllGroupList(): Promise<WXGroup[]> {
    const env = await this.get<PadProEnvelope<RawGroupListData>>('/group/GetAllGroupList');
    const d = env.Data;
    if (!d) return [];
    const list = d.ChatRoomList ?? d.chatRoomList ?? [];
    return list.map((g) => ({
      ChatRoomName: strFieldOrStr(g.ChatRoomName),
      NickName: strFieldOrStr(g.NickName),
      MemberCount: g.MemberCount,
    }));
  }

  /** Get details for specific groups */
  async getChatRoomInfo(groupIds: string[]): Promise<WXGroupInfo[]> {
    const env = await this.post<PadProEnvelope<RawGroupInfoData>>('/group/GetChatRoomInfo', {
      ChatRoomWxIdList: groupIds,
    });
    const d = env.Data;
    if (!d) return [];
    const list = d.ChatRoomInfoList ?? d.chatRoomList ?? d.contactList ?? [];
    return list.map((g) => {
      // memberList may come from top-level or from newChatroomData
      const rawMembers = g.memberList ?? g.newChatroomData?.chatroom_member_list ?? [];
      return {
        ChatRoomName: strFieldOrStr(g.chatroomUsername) ?? strFieldOrStr(g.userName),
        NickName: strFieldOrStr(g.nickName),
        MemberCount: g.memberCount ?? g.newChatroomData?.member_count,
        Announcement: strFieldOrStr(g.announcement),
        Owner: strFieldOrStr(g.chatroomOwner) ?? g.chatRoomOwner,
        MemberList: rawMembers.map((m) => ({
          UserName: strFieldOrStr(m.userName) ?? m.user_name,
          NickName: strFieldOrStr(m.nickName) ?? m.nick_name,
          DisplayName: strFieldOrStr(m.displayName) ?? m.display_name,
        })),
      };
    });
  }

  /** Get members of a group — groupId must include @chatroom suffix */
  async getChatroomMemberDetail(groupId: string): Promise<WXGroupMember[]> {
    const chatRoomName = groupId.endsWith('@chatroom') ? groupId : `${groupId}@chatroom`;
    const env = await this.post<PadProEnvelope<{ MemberList?: RawGroupMemberItem[] }>>(
      '/group/GetChatroomMemberDetail',
      { ChatRoomName: chatRoomName },
    );
    return (env.Data?.MemberList ?? []).map((m) => ({
      UserName: strFieldOrStr(m.userName),
      NickName: strFieldOrStr(m.nickName),
      DisplayName: strFieldOrStr(m.displayName),
    }));
  }

  // ──────────────────────────────────────────────────
  // Moments (SNS)
  // ──────────────────────────────────────────────────

  /** Get own moments timeline. Pass maxId from last result to paginate. */
  async getMomentsTimeline(maxId?: number): Promise<WXMoment[]> {
    const env = await this.post<PadProEnvelope<RawMomentsData>>('/sns/SendSnsTimeLine', {
      UserName: '',
      MaxID: maxId ?? 0,
      FirstPageMD5: '',
    });
    return (env.Data?.objectList ?? []).map(mapMoment);
  }

  /** Get a specific person's moments */
  async getUserMoments(wxid: string, maxId?: number): Promise<WXMoment[]> {
    const env = await this.post<PadProEnvelope<RawMomentsData>>('/sns/SendSnsUserPage', {
      UserName: wxid,
      MaxID: maxId ?? 0,
      FirstPageMD5: '',
    });
    return (env.Data?.objectList ?? []).map(mapMoment);
  }

  // ──────────────────────────────────────────────────
  // Message history
  // ──────────────────────────────────────────────────

  /** Sync recent messages via HTTP polling (read-only). count=0 means all buffered. */
  async syncMessages(count = 20): Promise<WXHistoryMessage[]> {
    const env = await this.post<PadProEnvelope<WXHistoryMessage[] | { List?: WXHistoryMessage[] }>>(
      '/message/HttpSyncMsg',
      { Count: count },
    );
    const data = env.Data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && 'List' in data) return data.List ?? [];
    return [];
  }

  // ──────────────────────────────────────────────────
  // Favorites
  // ──────────────────────────────────────────────────

  async getFavoriteList(favId = 0): Promise<WXFavorite[]> {
    const env = await this.post<PadProEnvelope<RawFavListData>>('/favor/GetFavList', {
      FavId: favId,
      KeyBuf: '',
    });
    return (env.Data?.List ?? []).map((f) => ({
      FavId: f.favId,
      Type: f.type,
      UpdateTime: f.updateTime,
    }));
  }

  // ──────────────────────────────────────────────────
  // Image download via CDN
  // ──────────────────────────────────────────────────

  /**
   * Download an image from WeChat CDN using aeskey + CDN URL key.
   * Returns the raw image buffer, or null if download fails.
   */
  async downloadCdnImage(aeskey: string, cdnUrl: string, fileType = 2): Promise<Buffer | null> {
    try {
      const env = await this.post<
        PadProEnvelope<{
          FileData?: string;
          TotalSize?: number;
          RetCode?: number;
        }>
      >('/message/SendCdnDownload', {
        AesKey: aeskey,
        FileURL: cdnUrl,
        FileType: fileType,
      });

      if (!env.Data?.FileData) {
        logger.warn('[WeChatPadProClient] SendCdnDownload: no FileData in response');
        return null;
      }

      const buf = Buffer.from(env.Data.FileData, 'base64');
      logger.debug(`[WeChatPadProClient] Downloaded CDN image: ${buf.length} bytes`);
      return buf;
    } catch (err) {
      logger.error('[WeChatPadProClient] SendCdnDownload failed:', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────
  // HTTP helpers
  // ──────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.base}${path}?key=${encodeURIComponent(this.authKey)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(this.timeout) });
    if (!resp.ok) throw new Error(`WeChatPadPro GET ${path} → HTTP ${resp.status}`);
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
    if (!resp.ok) throw new Error(`WeChatPadPro POST ${path} → HTTP ${resp.status}`);
    const json = (await resp.json()) as T;
    logger.debug(`[WeChatPadProClient] POST ${path} → ${resp.status}`);
    return json;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Extract string from PadPro's {str: "..."} wrapper. Returns undefined if empty. */
function strField(v: StrWrapper | undefined): string | undefined {
  const s = v?.str;
  return s ? s : undefined;
}

/** Handle fields that can be either {str} wrapper or a plain string. */
function strFieldOrStr(v: StrWrapper | string | undefined): string | undefined {
  if (typeof v === 'string') return v || undefined;
  return strField(v);
}

function mapContact(c: RawContact): WXContact {
  const remark = 'str' in c.remark ? (c.remark as StrWrapper).str : undefined;
  return {
    UserName: strField(c.userName),
    NickName: strField(c.nickName),
    Remark: remark || undefined,
    Sex: c.sex,
    Province: c.province || undefined,
    City: c.city || undefined,
  };
}

function mapMoment(m: RawMomentItem): WXMoment {
  return {
    id: String(m.id),
    userName: m.username,
    nickName: m.nickname,
    createTime: m.createTime,
    likeCount: m.likeCount,
    commentCount: m.commentCount,
    objectDescBuffer: m.objectDesc?.buffer,
  };
}
