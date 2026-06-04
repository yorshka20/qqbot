import { describe, expect, test } from 'bun:test';
import type { MessageSource } from '../../sources';
import { getSourceConfig } from '../registry';

describe('sourceRegistry', () => {
  test('每个 MessageSource 都能 lookup', () => {
    const all: MessageSource[] = [
      'qq-private',
      'qq-group',
      'discord',
      'avatar-cmd',
      'bilibili-danmaku',
      'idle-trigger',
      'bootstrap',
    ];
    for (const s of all) expect(getSourceConfig(s)).toBeDefined();
  });
  test('未知 source throw', () => {
    expect(() => getSourceConfig('not-a-source' as MessageSource)).toThrow();
  });
  test('avatar-cmd uses callback', () => {
    expect(getSourceConfig('avatar-cmd').responseHandler).toBe('callback');
  });
  test('bilibili-danmaku drops mid-flight danmaku', () => {
    expect(getSourceConfig('bilibili-danmaku').concurrency).toBe('drop');
  });
  test('qq-private drops concurrent messages, qq-group runs concurrent', () => {
    expect(getSourceConfig('qq-private').concurrency).toBe('drop');
    expect(getSourceConfig('qq-group').concurrency).toBe('concurrent');
  });
  test('qq-private has no poseLifecycle', () => {
    expect(getSourceConfig('qq-private').poseLifecycle).toBe(false);
  });
});
