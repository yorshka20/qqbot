import { describe, expect, test } from 'bun:test';
import { logLines, stripAnsi } from './logs';

describe('stripAnsi', () => {
  test('removes colour codes', () => {
    expect(stripAnsi('\u001b[32m$ bun test packages/bot\u001b[0m')).toBe('$ bun test packages/bot');
  });
});

describe('logLines', () => {
  test('strips ansi before splitting', () => {
    expect(logLines('\u001b[1m1420 pass\u001b[0m\n0 fail')).toEqual(['1420 pass', '0 fail']);
  });

  test('normalises CRLF without leaving stray \\r', () => {
    const lines = logLines('$ bun test packages/bot\r\n1420 pass\r\n0 fail');
    expect(lines).toEqual(['$ bun test packages/bot', '1420 pass', '0 fail']);
    expect(lines.some((line) => line.includes('\r'))).toBe(false);
  });

  test('an empty or whitespace-only string has no lines', () => {
    expect(logLines('')).toEqual([]);
    expect(logLines('   \n  \n')).toEqual([]);
  });

  test('a trailing newline does not produce an empty line', () => {
    expect(logLines('1420 pass\n0 fail\n')).toEqual(['1420 pass', '0 fail']);
  });
});
