// Milky event normalizer utilities
// Converts Milky protocol events to normalized BaseEvent format

import type { Event } from '@saltify/milky-types';
import type { BaseEvent } from '../base/types';
import { MilkyMessageSegmentParser } from './MilkyMessageSegmentParser';
import type {
  NormalizedMilkyMessageEvent,
  NormalizedMilkyMetaEvent,
  NormalizedMilkyNoticeEvent,
  NormalizedMilkyRequestEvent,
} from './types';

/**
 * Utility class for normalizing Milky protocol events
 * Handles conversion from Milky Event types to normalized BaseEvent format
 */
export class MilkyEventNormalizer {
  /**
   * Normalize a raw Milky event to BaseEvent format
   * @param rawEvent Raw event from Milky protocol
   * @returns Normalized event or null if invalid
   */
  static normalizeEvent(rawEvent: unknown): BaseEvent | null {
    if (typeof rawEvent !== 'object' || rawEvent === null) {
      return null;
    }

    const event = rawEvent as Event;

    // Check if it's a Milky event
    if (!('event_type' in event)) {
      return null;
    }

    const timestamp = event.time || Date.now();
    const baseEvent: BaseEvent = {
      id: `milky_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
      type: event.event_type,
      timestamp,
      protocol: 'milky',
    };

    switch (event.event_type) {
      case 'message_receive':
        return MilkyEventNormalizer.normalizeMessageEvent(event, baseEvent);
      case 'message_recall':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'message_recall',
        );
      case 'friend_request':
        return MilkyEventNormalizer.normalizeRequestEvent(
          event,
          baseEvent,
          'friend_request',
        );
      case 'group_join_request':
        return MilkyEventNormalizer.normalizeRequestEvent(
          event,
          baseEvent,
          'group_join_request',
        );
      case 'group_invited_join_request':
        return MilkyEventNormalizer.normalizeRequestEvent(
          event,
          baseEvent,
          'group_invited_join_request',
        );
      case 'group_invitation':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_invitation',
        );
      case 'friend_nudge':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'friend_nudge',
        );
      case 'friend_file_upload':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'friend_file_upload',
        );
      case 'group_admin_change':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_admin_change',
        );
      case 'group_essence_message_change':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_essence_message_change',
        );
      case 'group_member_increase':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_member_increase',
        );
      case 'group_member_decrease':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_member_decrease',
        );
      case 'group_name_change':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_name_change',
        );
      case 'group_message_reaction':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_message_reaction',
        );
      case 'group_mute':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_mute',
        );
      case 'group_whole_mute':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_whole_mute',
        );
      case 'group_nudge':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_nudge',
        );
      case 'group_file_upload':
        return MilkyEventNormalizer.normalizeNoticeEvent(
          event,
          baseEvent,
          'group_file_upload',
        );
      case 'bot_offline':
        return MilkyEventNormalizer.normalizeMetaEvent(
          event,
          baseEvent,
          'bot_offline',
        );
      default:
        return baseEvent;
    }
  }

  /**
   * Normalize a message receive event
   */
  private static normalizeMessageEvent(
    event: Extract<Event, { event_type: 'message_receive' }>,
    baseEvent: BaseEvent,
  ): NormalizedMilkyMessageEvent {
    const { data } = event;
    const messageType =
      data.message_scene === 'group' || data.message_scene === 'temp'
        ? 'group'
        : 'private';

    const normalized: NormalizedMilkyMessageEvent = {
      ...baseEvent,
      type: 'message',
      messageType,
      userId: data.sender_id,
      segments: data.segments,
      message: MilkyMessageSegmentParser.segmentsToText(data.segments),
      messageSeq: data.message_seq,
      messageScene: data.message_scene, // Save original message scene for temporary session handling
    };

    if (data.message_scene === 'group' || data.message_scene === 'temp') {
      normalized.groupId = data.peer_id;
      if ('group' in data && data.group) {
        normalized.groupName = data.group.group_name;
      }
    }

    if ('group_member' in data && data.group_member) {
      normalized.sender = {
        userId: data.group_member.user_id,
        nickname: data.group_member.nickname,
        card: data.group_member.card,
        role: data.group_member.role,
      };
    } else if ('friend' in data && data.friend) {
      normalized.sender = {
        userId: data.friend.user_id,
        nickname: data.friend.nickname,
      };
    }

    return normalized;
  }

  /**
   * Normalize a notice event
   */
  private static normalizeNoticeEvent(
    event: Event,
    baseEvent: BaseEvent,
    noticeType: string,
  ): NormalizedMilkyNoticeEvent {
    return {
      ...baseEvent,
      type: 'notice',
      noticeType,
      ...event.data,
    };
  }

  /**
   * Normalize a request event
   */
  private static normalizeRequestEvent(
    event: Event,
    baseEvent: BaseEvent,
    requestType: string,
  ): NormalizedMilkyRequestEvent {
    return {
      ...baseEvent,
      type: 'request',
      requestType,
      ...event.data,
    };
  }

  /**
   * Normalize a meta event
   */
  private static normalizeMetaEvent(
    event: Event,
    baseEvent: BaseEvent,
    metaEventType: string,
  ): NormalizedMilkyMetaEvent {
    return {
      ...baseEvent,
      type: 'meta_event',
      metaEventType,
      ...event.data,
    };
  }
}
