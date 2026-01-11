// Milky protocol types

export interface MilkyMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface MilkyMessageEvent {
  event_type: 'message_receive';
  data: {
    message_scene: 'group' | 'friend';
    sender_id: number;
    peer_id: number;
    segments: MilkyMessageSegment[];
    message_id?: number;
    group?: {
      group_id: number;
      group_name: string;
    };
    group_member?: {
      user_id: number;
      nickname: string;
      card?: string;
      role?: string;
    };
  };
}

export interface MilkyNoticeEvent {
  event_type: 'notice';
  data: {
    notice_type: string;
    [key: string]: unknown;
  };
}

export interface MilkyRequestEvent {
  event_type: 'request';
  data: {
    request_type: string;
    [key: string]: unknown;
  };
}

export interface MilkyMetaEvent {
  event_type: 'meta_event';
  data: {
    meta_event_type: string;
    [key: string]: unknown;
  };
}

export type MilkyEvent =
  | MilkyMessageEvent
  | MilkyNoticeEvent
  | MilkyRequestEvent
  | MilkyMetaEvent;
