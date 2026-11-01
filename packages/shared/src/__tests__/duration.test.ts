import { describe, expect, test } from 'bun:test';
import { parseDuration } from '../duration';
import { ConfigError } from '../errors';

describe('parseDuration', () => {
  test('units and bare milliseconds', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('600000')).toBe(600_000);
  });

  test('a malformed value is a config error, not a guessed timeout', () => {
    expect(() => parseDuration('15 min')).toThrow(ConfigError);
    expect(() => parseDuration('')).toThrow(ConfigError);
    expect(() => parseDuration('1.5h')).toThrow(ConfigError);
  });
});
