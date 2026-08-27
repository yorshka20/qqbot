// Tests for LLMDumpPlugin markdown rendering: a trace entry with tool calls must
// produce a per-turn markdown file showing input messages (incl. the model's
// tool_calls and the tool results fed back) and the response. Dialogue turns are
// rendered as a chat transcript; only bulk blocks (system prompts, tool payloads)
// get their own headings.

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMTraceEntry } from '@/ai/types';
import { LLMDumpPlugin } from '../LLMDumpPlugin';

let dir: string;

function makePlugin(): LLMDumpPlugin {
  const plugin = new LLMDumpPlugin({ name: 'llm-dump', version: 'test', description: 'test' });
  (plugin as unknown as { outputDir: string }).outputDir = dir;
  return plugin;
}

function emit(plugin: LLMDumpPlugin, entry: LLMTraceEntry): void {
  (plugin as unknown as { handleEntry: (e: LLMTraceEntry) => void }).handleEntry(entry);
}

/**
 * Read the markdown written for a turn (searches the day dir). Files are named
 * `<HHMMSS>-<turn>.md` so same-turn dumps sort chronologically; calls in
 * different seconds land in different files, so concatenate all matches in
 * name (= time) order.
 */
function readTurnFile(turn: string): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const days = fs.readdirSync(dir);
  for (const day of days) {
    const dayDir = join(dir, day);
    const files = fs
      .readdirSync(dayDir)
      .filter((f) => f.endsWith(`-${turn}.md`))
      .sort();
    if (files.length > 0) {
      return files.map((f) => readFileSync(join(dayDir, f), 'utf-8')).join('');
    }
  }
  throw new Error(`turn file *-${turn}.md not found under ${dir}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-dump-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LLMDumpPlugin', () => {
  it('renders a turn with numbered system prompts, fenced verbatim content', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      provider: 'gemini',
      resolvedModel: 'gemini-3.5-flash',
      prompt: 'ignored when messages present',
      messages: [
        { role: 'system', content: 'base system\n## 运行环境\nyou are a bot' },
        { role: 'system', content: 'scene system' },
        { role: 'user', content: 'hello' },
      ],
      response: { text: 'hi there', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      turnKey: 'msg:abc123',
    });

    const md = readTurnFile('msg-abc123');
    expect(md).toContain('# LLM dump — msg:abc123');
    expect(md).toContain('· generate · gemini · gemini-3.5-flash');
    // Two system prompts are numbered so base vs scene are distinguishable.
    expect(md).toContain('### system #1');
    expect(md).toContain('### system #2');
    // Prompt's own markdown header is fenced (kept verbatim, not promoted to an outline heading).
    expect(md).toContain('## 运行环境');
    expect(md).toContain('you are a bot');
    // Dialogue turns live in one transcript block, one line per message — no per-message heading.
    expect(md).toContain('### conversation');
    expect(md).not.toContain('### user');
    expect(md).toMatch(/^user {6}hello$/m);
    expect(md).toContain('hi there');
    expect(md).toContain('total=15');
    // The content header must sit inside a code fence, not start a real markdown heading.
    expect(md).toMatch(/```\n[\s\S]*## 运行环境/);
  });

  it('renders tool-calling: assistant tool_calls, tool result, and response function calls', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: 'search the web' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', name: 'search', arguments: '{"query":"qqbot"}' }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '8 results found' },
      ],
      response: {
        text: '',
        functionCalls: [{ toolCallId: 'call_2', name: 'send_card', arguments: '{"cards":[]}' }],
      },
      turnKey: 'msg:tool99',
    });

    const md = readTurnFile('msg-tool99');
    expect(md).toMatch(/^user {6}search the web$/m);
    // Input side: the model's tool_call and the tool result that was fed back.
    expect(md).toContain('`search` (call_1)');
    expect(md).toContain('"query": "qqbot"'); // pretty-printed JSON args
    expect(md).toContain('### tool ← call_1');
    expect(md).toContain('8 results found');
    // Output side: the response's function call.
    expect(md).toContain('tool calls (response):');
    expect(md).toContain('`send_card`');
  });

  it('appends multiple calls of the same turn in chronological order', () => {
    const plugin = makePlugin();
    const base = { provider: 'deepseek', prompt: '', turnKey: 'msg:same' } as const;
    emit(plugin, {
      ...base,
      opLabel: 'generate',
      messages: [{ role: 'user', content: 'first' }],
      response: { text: 'r1' },
    });
    emit(plugin, {
      ...base,
      opLabel: 'generate',
      messages: [{ role: 'user', content: 'second' }],
      response: { text: 'r2' },
    });

    const md = readTurnFile('msg-same');
    expect(md.indexOf('first')).toBeLessThan(md.indexOf('second'));
    expect(md.indexOf('r1')).toBeLessThan(md.indexOf('r2'));
    // Calls in the same second share one file (single header); a call landing
    // in the next second starts a new time-prefixed file with its own header.
    expect(md.match(/# LLM dump/g)?.length).toBeLessThanOrEqual(2);
  });

  it('keeps a multi-line message on one transcript line', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'first para\n\nsecond para' },
      ],
      response: { text: 'ok' },
      turnKey: 'msg:multiline',
    });

    const md = readTurnFile('msg-multiline');
    expect(md).toMatch(/^assistant first para ⏎ second para$/m);
  });

  it('falls back to a background file when no turn key is present', () => {
    const plugin = makePlugin();
    emit(plugin, { opLabel: 'generateLite', provider: 'groq', prompt: 'classify', response: { text: 'quick' } });
    const md = readTurnFile('background');
    expect(md).toContain('classify');
    expect(md).toContain('quick');
  });
});
