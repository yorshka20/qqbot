// Tests for LLMDumpPlugin markdown rendering: a trace entry with tool calls must
// produce a per-turn markdown file showing input messages (incl. the model's
// tool_calls and the tool results fed back) and the response.

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Read the single markdown file written for a turn (searches the day dir). */
function readTurnFile(turn: string): string {
  // Find the day directory (only one created during a test) then the turn file.
  const days = require('node:fs').readdirSync(dir) as string[];
  for (const day of days) {
    const file = join(dir, day, `${turn}.md`);
    if (existsSync(file)) return readFileSync(file, 'utf-8');
  }
  throw new Error(`turn file ${turn}.md not found under ${dir}`);
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
    expect(md).toContain('hello');
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
    // Input side: the model's tool_call and the tool result that was fed back.
    expect(md).toContain('`search` (call_1)');
    expect(md).toContain('"query": "qqbot"'); // pretty-printed JSON args
    expect(md).toContain('tool ← call_1');
    expect(md).toContain('8 results found');
    // Output side: the response's function call.
    expect(md).toContain('tool calls (response):');
    expect(md).toContain('`send_card`');
  });

  it('appends multiple calls of the same turn into one file in order', () => {
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
    // One header only.
    expect(md.match(/# LLM dump/g)?.length).toBe(1);
  });

  it('falls back to a background file when no turn key is present', () => {
    const plugin = makePlugin();
    emit(plugin, { opLabel: 'generateLite', provider: 'groq', prompt: 'classify', response: { text: 'quick' } });
    const md = readTurnFile('background');
    expect(md).toContain('classify');
    expect(md).toContain('quick');
  });
});
