// Milky protocol adapter implementation

import { ProtocolAdapter } from '../base/ProtocolAdapter';
import type { BaseEvent } from '../base/types';
import type {
  MilkyEvent,
  MilkyMessageEvent,
  MilkyNoticeEvent,
  MilkyRequestEvent,
  MilkyMetaEvent,
} from './types';
import { Connection } from '@/core/Connection';
import type { ProtocolConfig } from '@/core/Config';

export interface NormalizedMilkyMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: number;
  groupId?: number;
  message: string;
  segments: Array<{ type: string; data?: Record<string, unknown> }>;
  messageId?: number;
  groupName?: string;
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

export class MilkyAdapter extends ProtocolAdapter {
  constructor(config: ProtocolConfig, connection: Connection) {
    super(config, connection);
  }

  getProtocolName(): string {
    return 'milky';
  }

  normalizeEvent(rawEvent: unknown): BaseEvent | null {
    if (typeof rawEvent !== 'object' || rawEvent === null) {
      return null;
    }

    const event = rawEvent as MilkyEvent;

    // Check if it's a Milky event
    if (!('event_type' in event)) {
      return null;
    }

    const timestamp = Date.now();
    const baseEvent: BaseEvent = {
      id: `milky_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
      type: event.event_type,
      timestamp,
      protocol: 'milky',
    };

    switch (event.event_type) {
      case 'message_receive':
        return this.normalizeMessageEvent(event as MilkyMessageEvent, baseEvent);
      case 'notice':
        return this.normalizeNoticeEvent(event, baseEvent);
      case 'request':
        return this.normalizeRequestEvent(event, baseEvent);
      case 'meta_event':
        return this.normalizeMetaEvent(event, baseEvent);
      default:
        return baseEvent;
    }
  }

  private normalizeMessageEvent(
    event: MilkyMessageEvent,
    baseEvent: BaseEvent
  ): NormalizedMilkyMessageEvent {
    const { data } = event;
    const messageType = data.message_scene === 'group' ? 'group' : 'private';

    const normalized: NormalizedMilkyMessageEvent = {
      ...baseEvent,
      type: 'message',
      messageType,
      userId: data.sender_id,
      segments: data.segments || [],
      message: this.segmentsToText(data.segments || []),
    };

    if (data.message_id) {
      normalized.messageId = data.message_id;
    }

    if (messageType === 'group') {
      normalized.groupId = data.peer_id;
      if (data.group) {
        normalized.groupName = data.group.group_name;
      }
    }

    if (data.group_member) {
      normalized.sender = {
        userId: data.group_member.user_id,
        nickname: data.group_member.nickname,
        card: data.group_member.card,
        role: data.group_member.role,
      };
    }

    return normalized;
  }

  private normalizeNoticeEvent(
    event: MilkyNoticeEvent,
    baseEvent: BaseEvent
  ): NormalizedMilkyNoticeEvent {
    return {
      ...baseEvent,
      type: 'notice',
      noticeType: event.data.notice_type,
      ...event.data,
    };
  }

  private normalizeRequestEvent(
    event: MilkyRequestEvent,
    baseEvent: BaseEvent
  ): NormalizedMilkyRequestEvent {
    return {
      ...baseEvent,
      type: 'request',
      requestType: event.data.request_type,
      ...event.data,
    };
  }

  private normalizeMetaEvent(
    event: MilkyMetaEvent,
    baseEvent: BaseEvent
  ): NormalizedMilkyMetaEvent {
    return {
      ...baseEvent,
      type: 'meta_event',
      metaEventType: event.data.meta_event_type,
      ...event.data,
    };
  }

  private segmentsToText(segments: Array<{ type: string; data?: Record<string, unknown> }>): string {
    return segments
      .map((segment) => {
        switch (segment.type) {
          case 'text':
            return (segment.data?.text as string) || '';
          case 'at':
            return `@${segment.data?.qq || ''}`;
          case 'face':
            return `[Face:${segment.data?.id || ''}]`;
          case 'image':
            return `[Image:${segment.data?.file || ''}]`;
          case 'reply':
            return `[Reply:${segment.data?.id || ''}]`;
          default:
            return `[${segment.type}]`;
        }
      })
      .join('');
  }
}
