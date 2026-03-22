// Discord protocol normalized event types

import type { NormalizedNoticeEvent } from '@/events/types';
import type { BaseEvent } from '../base/types';

export interface NormalizedDiscordMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: string;
  groupId?: string;
  message: string;
  rawMessage?: string;
  messageId: string;
  segments?: Array<{ type: string; data?: Record<string, unknown> }>;
  groupName?: string;
  sender?: {
    userId: string;
    nickname?: string;
    card?: string;
    role?: string;
  };
}

export type NormalizedDiscordNoticeEvent = NormalizedNoticeEvent;

export interface NormalizedDiscordMetaEvent extends BaseEvent {
  type: 'meta_event';
  metaEventType: string;
  [key: string]: unknown;
}

export type NormalizedDiscordEvent =
  | NormalizedDiscordMessageEvent
  | NormalizedDiscordNoticeEvent
  | NormalizedDiscordMetaEvent;
