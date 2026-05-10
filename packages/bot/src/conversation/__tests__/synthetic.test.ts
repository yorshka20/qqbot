import { describe, expect, it } from 'bun:test';
import { makeSyntheticEvent } from '../synthetic';

describe('makeSyntheticEvent', () => {
  it('avatar-cmd: produces event with correct id prefix and round-trip fields', () => {
    const event = makeSyntheticEvent({
      source: 'avatar-cmd',
      userId: 'user-1',
      groupId: null,
      text: 'hello',
      messageType: 'private',
      protocol: 'milky',
    });
    expect(event.id.startsWith('synthetic-avatar-cmd-')).toBe(true);
    expect(event.messageId).toBe(event.id);
    expect(event.userId).toBe('user-1');
    expect(event.message).toBe('hello');
    expect(event.rawMessage).toBe('hello');
    expect(event.messageType).toBe('private');
    expect(event.protocol).toBe('milky');
    expect(event.type).toBe('message');
  });

  it('bilibili-danmaku: produces event with correct id prefix', () => {
    const event = makeSyntheticEvent({
      source: 'bilibili-danmaku',
      userId: 'user-2',
      groupId: 'group-1',
      text: 'danmaku text',
      messageType: 'group',
      protocol: 'milky',
    });
    expect(event.id.startsWith('synthetic-bilibili-danmaku-')).toBe(true);
    expect(event.groupId).toBe('group-1');
    expect(event.messageType).toBe('group');
  });

  it('idle-trigger: produces event with correct id prefix', () => {
    const event = makeSyntheticEvent({
      source: 'idle-trigger',
      userId: 'system',
      groupId: null,
      text: 'idle',
      messageType: 'private',
      protocol: 'milky',
    });
    expect(event.id.startsWith('synthetic-idle-trigger-')).toBe(true);
    expect(event.userId).toBe('system');
  });

  it('bootstrap: produces event with correct id prefix', () => {
    const event = makeSyntheticEvent({
      source: 'bootstrap',
      userId: 'owner-1',
      groupId: null,
      text: 'bootstrap message',
      messageType: 'private',
      protocol: 'milky',
    });
    expect(event.id.startsWith('synthetic-bootstrap-')).toBe(true);
    expect(event.message).toBe('bootstrap message');
  });

  it('timestamp defaults to a recent value when not provided', () => {
    const before = Date.now();
    const event = makeSyntheticEvent({
      source: 'avatar-cmd',
      userId: 'u',
      groupId: null,
      text: '',
      messageType: 'private',
      protocol: 'milky',
    });
    const after = Date.now();
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it('uses provided timestamp when given', () => {
    const ts = 1700000000000;
    const event = makeSyntheticEvent({
      source: 'avatar-cmd',
      userId: 'u',
      groupId: null,
      text: '',
      messageType: 'private',
      protocol: 'milky',
      timestamp: ts,
    });
    expect(event.timestamp).toBe(ts);
  });

  it('two consecutive calls produce different id and messageId', () => {
    const input = {
      source: 'avatar-cmd' as const,
      userId: 'u',
      groupId: null,
      text: 'test',
      messageType: 'private' as const,
      protocol: 'milky' as const,
    };
    const e1 = makeSyntheticEvent(input);
    const e2 = makeSyntheticEvent(input);
    expect(e1.id).not.toBe(e2.id);
    expect(e1.messageId).not.toBe(e2.messageId);
  });

  it('groupId is omitted when input groupId is null', () => {
    const event = makeSyntheticEvent({
      source: 'avatar-cmd',
      userId: 'u',
      groupId: null,
      text: '',
      messageType: 'private',
      protocol: 'milky',
    });
    expect('groupId' in event).toBe(false);
  });

  it('groupId is present when input groupId is a string', () => {
    const event = makeSyntheticEvent({
      source: 'bilibili-danmaku',
      userId: 'u',
      groupId: 'g-1',
      text: '',
      messageType: 'group',
      protocol: 'milky',
    });
    expect('groupId' in event).toBe(true);
    expect(event.groupId).toBe('g-1');
  });
});
