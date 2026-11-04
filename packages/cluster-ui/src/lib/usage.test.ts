import { describe, expect, test } from 'bun:test';
import { formatTokens, usageFacts } from './usage';

describe('formatTokens', () => {
  test('exact below a thousand, then k, then M', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(1_250_000)).toBe('1.25M');
  });

  test('drops a zero fraction', () => {
    expect(formatTokens(12_000)).toBe('12k');
    expect(formatTokens(2_000_000)).toBe('2M');
  });
});

describe('usageFacts', () => {
  test('reads every number the CLI reported', () => {
    expect(
      usageFacts({
        contextTokens: 8_400,
        inputTokens: 12_000,
        outputTokens: 950,
        cacheReadTokens: 2_000,
        cacheCreationTokens: 500,
        turns: 7,
        costUsd: 0.42,
        final: true,
      }),
    ).toEqual({
      context: '8.4k',
      input: '12k',
      output: '950',
      cache: '2.5k',
      turns: '7',
      cost: '$0.42',
      final: true,
    });
  });

  test('no usage is all unknown', () => {
    expect(usageFacts(undefined)).toEqual({
      context: '未知',
      input: '未知',
      output: '未知',
      cache: '未知',
      turns: '未知',
      cost: null,
      final: false,
    });
  });

  test('turns and cost stay unknown when the CLI did not report them', () => {
    expect(
      usageFacts({ contextTokens: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    ).toMatchObject({ turns: '未知', cost: null, final: false });
  });
});
