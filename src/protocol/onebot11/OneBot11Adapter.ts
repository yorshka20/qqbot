// OneBot11 protocol adapter implementation

import { ProtocolAdapter } from '../base/ProtocolAdapter';
import type { BaseEvent } from '../base/types';
import type {
  OneBot11Event,
  OneBot11MessageEvent,
  OneBot11NoticeEvent,
  OneBot11RequestEvent,
  OneBot11MetaEvent,
} from './types';
import { Connection } from '@/core/Connection';
import type { ProtocolConfig } from '@/core/Config';

export interface NormalizedMessageEvent extends BaseEvent {
  type: 'message';
  messageType: 'private' | 'group';
  userId: number;
  groupId?: number;
  message: string;
  rawMessage: string;
  messageId: number;
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

export type NormalizedOneBot11Event =
  | NormalizedMessageEvent
  | NormalizedNoticeEvent
  | NormalizedRequestEvent
  | NormalizedMetaEvent;

export class OneBot11Adapter extends ProtocolAdapter {
  constructor(config: ProtocolConfig, connection: Connection) {
    super(config, connection);
  }

  getProtocolName(): string {
    return 'onebot11';
  }

  normalizeEvent(rawEvent: unknown): BaseEvent | null {
    if (typeof rawEvent !== 'object' || rawEvent === null) {
      return null;
    }

    const event = rawEvent as OneBot11Event;

    // Check if it's a OneBot11 event
    if (!('post_type' in event)) {
      return null;
    }

    const baseEvent: BaseEvent = {
      id: `onebot11_${event.time}_${Math.random().toString(36).substr(2, 9)}`,
      type: event.post_type,
      timestamp: event.time * 1000, // Convert to milliseconds
      protocol: 'onebot11',
    };

    switch (event.post_type) {
      case 'message':
        return this.normalizeMessageEvent(event as OneBot11MessageEvent, baseEvent);
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
    event: OneBot11MessageEvent,
    baseEvent: BaseEvent
  ): NormalizedMessageEvent {
    const normalized: NormalizedMessageEvent = {
      ...baseEvent,
      type: 'message',
      messageType: event.message_type,
      userId: event.user_id,
      message: event.message,
      rawMessage: event.raw_message,
      messageId: event.message_id,
    };

    if (event.group_id) {
      normalized.groupId = event.group_id;
    }

    if (event.sender) {
      normalized.sender = {
        userId: event.sender.user_id,
        nickname: event.sender.nickname,
        card: event.sender.card,
        role: event.sender.role,
      };
    }

    return normalized;
  }

  private normalizeNoticeEvent(
    event: OneBot11NoticeEvent,
    baseEvent: BaseEvent
  ): NormalizedNoticeEvent {
    return {
      ...baseEvent,
      type: 'notice',
      noticeType: event.notice_type,
      ...event,
    };
  }

  private normalizeRequestEvent(
    event: OneBot11RequestEvent,
    baseEvent: BaseEvent
  ): NormalizedRequestEvent {
    return {
      ...baseEvent,
      type: 'request',
      requestType: event.request_type,
      ...event,
    };
  }

  private normalizeMetaEvent(
    event: OneBot11MetaEvent,
    baseEvent: BaseEvent
  ): NormalizedMetaEvent {
    return {
      ...baseEvent,
      type: 'meta_event',
      metaEventType: event.meta_event_type,
      ...event,
    };
  }
}
