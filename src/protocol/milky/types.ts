// Milky protocol normalized event types
// Shared types for Milky adapter and normalizer

import type { IncomingSegment } from '@saltify/milky-types';
import type { NormalizedNoticeEvent } from '@/events/types';
import type { BaseEvent } from '../base/types';

/**
 * Milky API response format
 * Actual format returned by Milky API: { status: string, retcode: number, data?: T }
 * @see https://github.com/SaltifyDev/milky
 */
export interface MilkyAPIResponse<T = unknown> {
  status: string;
  retcode: number;
  message?: string;
  data?: T;
}

/**
 * Normalized Milky message event.
 * Shape is aligned with MilkyEventNormalizer.normalizeMessageEvent output.
 *
 * Required (always set by normalizer):
 * - id, type, timestamp, protocol (BaseEvent)
 * - messageType, userId, message, segments (always set; segments is [] when API omits)
 *
 * Optional (set only when present from API or for group/temp):
 * - groupId: only when message_scene is 'group' or 'temp'
 * - messageSeq: from data.message_seq (API may omit)
 * - groupName: only when data.group exists
 * - messageScene: from data.message_scene (API may omit)
 * - sender: only when data.group_member or data.friend exists
 */
export interface NormalizedMilkyMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: number;
  message: string;
  segments: IncomingSegment[];

  /** Only set when message_scene is 'group' or 'temp'. */
  groupId?: number;
  /** From data.message_seq; API may omit. */
  messageSeq?: number;
  /** Only set when event includes group info. */
  groupName?: string;
  /** From data.message_scene (e.g. 'private', 'group', 'temp'); API may omit. */
  messageScene?: string;
  /** Set when data.group_member (group) or data.friend (private) is present. */
  sender?: {
    userId: number;
    nickname?: string;
    card?: string;
    role?: string;
  };
}

/** Milky notice events use the shared normalized shape (camelCase). */
export type NormalizedMilkyNoticeEvent = NormalizedNoticeEvent;

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
