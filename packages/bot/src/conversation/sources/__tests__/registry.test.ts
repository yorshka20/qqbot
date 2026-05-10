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
  test('bilibili-danmaku is serial', () => {
    expect(getSourceConfig('bilibili-danmaku').serial).toBe(true);
  });
  test('qq-private has no poseLifecycle', () => {
    expect(getSourceConfig('qq-private').poseLifecycle).toBe(false);
  });
});
