// Event type definitions

import type { BaseEvent } from '@/protocol/base/types';

export interface NormalizedMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: number;
  groupId?: number;
  message: string;
  rawMessage?: string;
  messageId?: number;
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
  groupName?: string;
  sender?: {
    userId: number;
    nickname?: string;
    card?: string;
    role?: string;
  };
}

export interface NormalizedNoticeEvent extends BaseEvent {
  type: 'notice';
  noticeType: string;
  [key: string]: unknown;
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

export type EventHandler<T extends NormalizedEvent = NormalizedEvent> = (
  event: T
) => void | Promise<void>;
