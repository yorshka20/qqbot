// Milky protocol normalized event types
// Shared types for Milky adapter and normalizer

import type { IncomingSegment } from '@saltify/milky-types';
import type { BaseEvent } from '../base/types';

/**
 * Milky API response format
 * @see https://github.com/SaltifyDev/milky
 */
export interface MilkyAPIResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

export interface NormalizedMilkyMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: number;
  groupId?: number;
  message: string;
  segments: IncomingSegment[];
  messageSeq?: number;
  groupName?: string;
  // Message scene from Milky protocol (e.g., 'private', 'group', 'temp' for temporary session)
  messageScene?: string;
  sender?: {
    userId: number;
    nickname?: string;
    card?: string;
    role?: string;
  };
}

export interface NormalizedMilkyNoticeEvent extends BaseEvent {
  type: 'notice';
  noticeType: string;
  [key: string]: unknown;
}

export interface NormalizedMilkyRequestEvent extends BaseEvent {
  type: 'request';
  requestType: string;
  [key: string]: unknown;
}

export interface NormalizedMilkyMetaEvent extends BaseEvent {
  type: 'meta_event';
  metaEventType: string;
  [key: string]: unknown;
}

export type NormalizedMilkyEvent =
  | NormalizedMilkyMessageEvent
  | NormalizedMilkyNoticeEvent
  | NormalizedMilkyRequestEvent
  | NormalizedMilkyMetaEvent;
