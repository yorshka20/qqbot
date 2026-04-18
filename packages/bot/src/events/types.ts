// Event type definitions

import type { BaseEvent } from '@/protocol/base/types';

export interface NormalizedMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: number | string;
  groupId?: number | string;
  message: string;
  rawMessage?: string;
  messageId?: number | string;
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
  groupName?: string;
  // Message scene from protocol (e.g., 'private', 'group', 'temp' for temporary session)
  messageScene?: string;
  sender?: {
    userId: number | string;
    nickname?: string;
    card?: string;
    role?: string;
  };
}

export interface NormalizedNoticeEvent extends BaseEvent {
  type: 'notice';
  noticeType: string;
  /** Set by normalizer for group-related notices (e.g. group_message_reaction) so the event can be used as MessageAPI context. */
  groupId?: number | string;
  /** Set by normalizer for group-related notices so the event can be used as MessageAPI context. */
  messageType?: 'private' | 'group';
  /** Optional; e.g. user_id from reaction data when used as context. */
  userId?: number | string;
  messageScene?: string;
  // Group message reaction (group_message_reaction), normalized camelCase
  faceId?: number;
  messageSeq?: number;
  isAdd?: boolean;
  // Group nudge (group_nudge), normalized camelCase
  senderId?: number;
  receiverId?: number;
  displayAction?: string;
  displaySuffix?: string;
  displayActionImgUrl?: string;
}

export interface NormalizedRequestEvent extends BaseEvent {
  type: 'request';
  requestType: string;
  [key: string]: unknown;
}

export interface NormalizedMetaEvent extends BaseEvent {
  type: 'meta_event';
  metaEventType: string;
  [key: string]: unknown;
}

export type NormalizedEvent =
  | NormalizedMessageEvent
  | NormalizedNoticeEvent
  | NormalizedRequestEvent
  | NormalizedMetaEvent;

export type EventHandler<T extends NormalizedEvent = NormalizedEvent> = (event: T) => void | Promise<void>;
