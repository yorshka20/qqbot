import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { parseLogFiles } from '../DailyStatsBackend';

const dirs: string[] = [];

function writeDay(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'daily-stats-'));
  dirs.push(root);
  const day = join(root, '2026-09-27');
  mkdirSync(day);
  writeFileSync(join(day, '2026-09-27-00-00-00.log'), `${lines.join('\n')}\n`);
  return root;
}

function provider(root: string, name: string) {
  const row = parseLogFiles(root, '2026-09-27').providerStats.find((p) => p.provider === name);
  if (!row) {
    throw new Error(`missing provider ${name}`);
  }
  return row;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('parseLogFiles provider calls', () => {
  it('counts a completion that has no attempt log', () => {
    const root = writeDay([
      '[2026-09-27 14:32:00] [INFO] [msg:abc123] [STATS] [LLMService] usage | provider=gemini | promptTokens=10 | completionTokens=2 | totalTokens=12 | promptChars=100 | responseChars=5',
      '[2026-09-27 14:33:00] [INFO] [STATS] [LLMService] usage | provider=gemini | promptTokens=4 | completionTokens=1 | totalTokens=5 | promptChars=20 | responseChars=3 | cachedPromptTokens=1',
    ]);

    const stats = parseLogFiles(root, '2026-09-27');
    const gemini = provider(root, 'gemini');

    expect(gemini.callCount).toBe(2);
    expect(gemini.promptTokens).toBe(14);
    expect(gemini.completionTokens).toBe(3);
    expect(gemini.totalTokens).toBe(17);
    expect(gemini.promptChars).toBe(120);
    expect(gemini.responseChars).toBe(8);
    expect(stats.summary.totalLLMCalls).toBe(2);
    expect(stats.hourlyActivity[14].llmCalls).toBe(2);
  });

  it('does not double-count a call that logs both an attempt and a completion', () => {
    const root = writeDay([
      '[2026-09-27 09:01:00] [INFO] [STATS] [DeepSeekProvider] Generating with model: deepseek-chat',
      '[2026-09-27 09:01:02] [INFO] [msg:abc123] [STATS] [LLMService] usage | provider=deepseek | promptTokens=8 | completionTokens=2 | totalTokens=10 | promptChars=30 | responseChars=6',
    ]);

    const row = provider(root, 'deepseek');
    const stats = parseLogFiles(root, '2026-09-27');

    expect(row.callCount).toBe(1);
    expect(row.totalTokens).toBe(10);
    expect(stats.summary.totalLLMCalls).toBe(1);
    expect(stats.hourlyActivity[9].llmCalls).toBe(1);
  });

  it('keeps failed attempts that never reach a usage line', () => {
    const root = writeDay([
      '[2026-09-27 11:00:00] [INFO] [STATS] [DoubaoProvider] Generating with model: doubao-seed',
      '[2026-09-27 11:00:01] [INFO] [STATS] [DoubaoProvider] Generating with model: doubao-seed',
      '[2026-09-27 11:00:02] [INFO] [STATS] [DoubaoProvider] Generating with model (chat/completions): doubao-lite',
      '[2026-09-27 11:00:03] [INFO] [STATS] [LLMService] usage | provider=doubao | promptTokens=1 | completionTokens=1 | totalTokens=2 | promptChars=3 | responseChars=4',
      '[2026-09-27 11:00:04] [INFO] [STATS] [LLMService] usage | provider=doubao | promptTokens=1 | completionTokens=1 | totalTokens=2 | promptChars=3 | responseChars=4',
    ]);

    expect(provider(root, 'doubao').callCount).toBe(3);
    expect(parseLogFiles(root, '2026-09-27').hourlyActivity[11].llmCalls).toBe(3);
  });
});
