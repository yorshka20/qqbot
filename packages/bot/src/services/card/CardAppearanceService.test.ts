/**
 * Unit tests for CardAppearanceService: the auto-mode night window, which wraps
 * past midnight and is evaluated in Asia/Tokyo rather than the machine timezone.
 */

import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import type { Config } from '@/core/config';
import type { CardRenderConfig } from '@/core/config/types/cardRender';
import { CardAppearanceService } from './CardAppearanceService';

function makeService(cardRender?: CardRenderConfig): CardAppearanceService {
  return new CardAppearanceService({ getCardRenderConfig: () => cardRender } as Config);
}

/** `hour` is JST; the Date is built from the equivalent UTC instant. */
function atJstHour(hour: number): Date {
  return new Date(Date.UTC(2026, 9, 11, (hour - 9 + 24) % 24, 30));
}

describe('CardAppearanceService', () => {
  test('auto renders dark inside the default 18:00-09:00 window', () => {
    const service = makeService();
    expect(service.resolve(atJstHour(18))).toBe('dark');
    expect(service.resolve(atJstHour(23))).toBe('dark');
    expect(service.resolve(atJstHour(3))).toBe('dark');
    expect(service.resolve(atJstHour(8))).toBe('dark');
  });

  test('auto renders light outside the window', () => {
    const service = makeService();
    expect(service.resolve(atJstHour(9))).toBe('light');
    expect(service.resolve(atJstHour(12))).toBe('light');
    expect(service.resolve(atJstHour(17))).toBe('light');
  });

  test('a window that does not wrap stays a plain interval', () => {
    const service = makeService({ darkHours: { from: 1, to: 5 } });
    expect(service.resolve(atJstHour(0))).toBe('light');
    expect(service.resolve(atJstHour(1))).toBe('dark');
    expect(service.resolve(atJstHour(4))).toBe('dark');
    expect(service.resolve(atJstHour(5))).toBe('light');
  });

  test('a pinned mode ignores the window', () => {
    const service = makeService({ appearance: 'dark' });
    expect(service.resolve(atJstHour(12))).toBe('dark');

    service.setMode('light');
    expect(service.resolve(atJstHour(23))).toBe('light');

    service.setMode('auto');
    expect(service.resolve(atJstHour(23))).toBe('dark');
  });

  test('rejects hours outside 0-23', () => {
    expect(() => makeService({ darkHours: { from: 18, to: 24 } })).toThrow(/whole hours in 0-23/);
  });

  test('describes the window for command output', () => {
    expect(makeService().describeDarkWindow()).toBe('18:00-09:00');
    expect(makeService({ darkHours: { from: 1, to: 5 } }).describeDarkWindow()).toBe('01:00-05:00');
  });
});
