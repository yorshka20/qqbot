import { describe, expect, it } from 'bun:test';
import type { NormalizedNoticeEvent } from '@/events/types';
import { MilkyEventNormalizer } from './MilkyEventNormalizer';

function recallEvent(scene: 'group' | 'friend' | 'temp', peerId: number): NormalizedNoticeEvent {
  return MilkyEventNormalizer.normalizeEvent({
    event_type: 'message_recall',
    time: 1_790_000_000,
    self_id: 10000009,
    data: {
      message_scene: scene,
      peer_id: peerId,
      message_seq: 4242,
      sender_id: 10000001,
      operator_id: 10000002,
      display_suffix: '',
    },
  }) as NormalizedNoticeEvent;
}

describe('MilkyEventNormalizer message_recall', () => {
  it('addresses a group recall by its group', () => {
    const notice = recallEvent('group', 20000001);

    expect(notice.noticeType).toBe('message_recall');
    expect(notice.messageType).toBe('group');
    expect(notice.groupId).toBe(20000001);
    expect(notice.messageSeq).toBe(4242);
    expect(notice.senderId).toBe(10000001);
    expect(notice.operatorId).toBe(10000002);
  });

  it('addresses a friend recall by the peer user, not as a group', () => {
    const notice = recallEvent('friend', 10000003);

    expect(notice.messageType).toBe('private');
    expect(notice.userId).toBe(10000003);
    expect(notice.groupId).toBeUndefined();
  });

  it('treats a temp-session recall as private', () => {
    const notice = recallEvent('temp', 10000004);

    expect(notice.messageType).toBe('private');
    expect(notice.userId).toBe(10000004);
    expect(notice.messageScene).toBe('temp');
  });
});
