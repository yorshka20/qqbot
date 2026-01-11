// OneBot11 protocol types

export interface OneBot11MessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  time: number;
  self_id: number;
  sub_type?: string;
  message_id: number;
  user_id: number;
  message: string;
  raw_message: string;
  font?: number;
  sender?: {
    user_id: number;
    nickname?: string;
    sex?: string;
    age?: number;
    card?: string;
    area?: string;
    level?: string;
    role?: string;
    title?: string;
  };
  group_id?: number;
  anonymous?: unknown;
  message_seq?: number;
}

export interface OneBot11NoticeEvent {
  post_type: 'notice';
  notice_type: string;
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export interface OneBot11RequestEvent {
  post_type: 'request';
  request_type: string;
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export interface OneBot11MetaEvent {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export type OneBot11Event =
  | OneBot11MessageEvent
  | OneBot11NoticeEvent
  | OneBot11RequestEvent
  | OneBot11MetaEvent;
