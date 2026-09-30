// Tests for LLMDumpPlugin markdown rendering: a trace entry with tool calls must
// produce a per-turn markdown file showing input messages (incl. the model's
// tool_calls and the tool results fed back) and the response. Dialogue turns are
// rendered as a chat transcript; only bulk blocks (system prompts, tool payloads)
// get their own headings.

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMTraceEntry } from '@/ai/types';
import { randomUUID } from '@/utils/randomUUID';
import { LLMDumpPlugin } from '../LLMDumpPlugin';

let dir: string;

function makePlugin(): LLMDumpPlugin {
  const plugin = new LLMDumpPlugin({ name: 'llm-dump', version: 'test', description: 'test' });
  (plugin as unknown as { outputDir: string }).outputDir = dir;
  return plugin;
}

/** Emits a trace entry; one without a conversation id is a single-call conversation of its own. */
function emit(plugin: LLMDumpPlugin, entry: Omit<LLMTraceEntry, 'conversationId'> & { conversationId?: string }): void {
  (plugin as unknown as { handleEntry: (e: LLMTraceEntry) => void }).handleEntry({
    ...entry,
    conversationId: entry.conversationId ?? randomUUID(),
  });
}

/**
 * Read the one markdown file written for a turn: `<HHMMSS>-<turn>.md`, where a
 * call outside any turn is named `background-<conversation id prefix>`.
 */
function readTurnFile(turn: string): string {
  const name = new RegExp(`^\\d{6}-${turn}(-[0-9a-f]{8})?\\.md$`);
  const files = readdirSync(dir).flatMap((day) =>
    readdirSync(join(dir, day))
      .filter((f) => name.test(f))
      .map((f) => join(dir, day, f)),
  );
  expect(files.length).toBe(1);
  return readFileSync(files[0], 'utf-8');
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
      durationMs: 1234,
      provider: 'gemini',
      resolvedModel: 'gemini-3.5-flash',
      prompt: 'ignored when messages present',
      messages: [
        { role: 'system', content: 'base system\n## 运行环境\nyou are a bot' },
        { role: 'system', content: 'scene system' },
        { role: 'user', content: 'hello' },
        { role: 'user', content: '<current_query>\n当前问题：q\n</current_query>' },
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
    // Dialogue turns live in one transcript block, header line + body — no per-message heading.
    expect(md).toContain('### conversation');
    expect(md).not.toContain('### user');
    expect(md).toMatch(/^=+ user =+\nhello$/m);
    expect(md).toContain('hi there');
    expect(md).toContain('> round 1 · tokens: prompt=10 completion=5 total=15 · elapsed: 1.2s');
    // The content header must sit inside a code fence, not start a real markdown heading.
    expect(md).toMatch(/```\n[\s\S]*## 运行环境/);
    // Providers ignore the positional prompt when messages are present, so the dump must too.
    expect(md).not.toContain('ignored when messages present');
  });

  it('renders options.systemPrompt alongside messages (generateFixed shape)', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generateFixed',
      durationMs: 500,
      provider: 'deepseek',
      prompt: '',
      systemPrompt: '反思任务说明\n当前 phenotype: {...}',
      messages: [{ role: 'user', content: '请根据以上输入完成反思，输出符合格式要求的 JSON。' }],
      response: { text: '{}' },
      turnKey: 'background',
    });

    const md = readTurnFile('background');
    // The out-of-band system prompt is prepended by providers, so it must appear in the dump.
    expect(md).toContain('### system');
    expect(md).toContain('反思任务说明');
    expect(md).toContain('### conversation');
    expect(md).toContain('请根据以上输入完成反思');
  });

  it('renders tool-calling: assistant tool_calls, tool result, and response function calls', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 1234,
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: 'search the web' },
        { role: 'user', content: '<current_query>\n当前问题：q\n</current_query>' },
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
    expect(md).toMatch(/^=+ user =+\nsearch the web$/m);
    // Input side: the model's tool_call and the tool result that was fed back.
    expect(md).toContain('`search` (call_1)');
    expect(md).toContain('"query": "qqbot"'); // pretty-printed JSON args
    expect(md).toContain('### tool ← call_1');
    expect(md).toContain('8 results found');
    // Output side: the response's function call.
    expect(md).toContain('tool calls (response):');
    expect(md).toContain('`send_card`');
  });

  it('gives each conversation of a turn its own section, in the order they started, in one file', () => {
    const plugin = makePlugin();
    const base = { provider: 'deepseek', prompt: '', turnKey: 'msg:same', opLabel: 'generate', durationMs: 1234 } as const;
    emit(plugin, { ...base, messages: [{ role: 'user', content: 'first' }], response: { text: 'r1' } });
    emit(plugin, { ...base, messages: [{ role: 'user', content: 'second' }], response: { text: 'r2' } });

    const md = readTurnFile('msg-same');
    expect(md.match(/# LLM dump/g)?.length).toBe(1);
    expect(md.match(/^## /gm)?.length).toBe(2);
    expect(md.indexOf('first')).toBeLessThan(md.indexOf('second'));
    expect(md.indexOf('r1')).toBeLessThan(md.indexOf('r2'));
  });

  it('re-renders a tool loop from its latest round and keeps a stats row per round', () => {
    const plugin = makePlugin();
    const base = { provider: 'deepseek', prompt: '', turnKey: 'msg:loop', opLabel: 'generate' } as const;
    const firstRound = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'look it up' }] as const;
    emit(plugin, { ...base, conversationId: 'loop-1', messages: [{ role: 'user', content: 'classify' }], durationMs: 300, response: { text: 'deep' } });
    emit(plugin, {
      ...base,
      conversationId: 'loop-2',
      durationMs: 2000,
      messages: [...firstRound],
      response: {
        text: '',
        reasoningContent: 'need a search',
        functionCalls: [{ toolCallId: 'call_1', name: 'search', arguments: '{}' }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });
    emit(plugin, {
      ...base,
      conversationId: 'loop-2',
      durationMs: 1000,
      messages: [
        ...firstRound,
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'need a search',
          tool_calls: [{ id: 'call_1', name: 'search', arguments: '{}' }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found it' },
      ],
      response: { text: 'here you go', usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 } },
    });

    const md = readTurnFile('msg-loop');
    // The classifier's section stays; the loop's two rounds collapse into one section.
    expect(md.match(/^## /gm)?.length).toBe(2);
    expect(md.indexOf('classify')).toBeLessThan(md.indexOf('look it up'));
    expect(md.match(/look it up/g)?.length).toBe(1);
    // Round 1's thinking survives as the echoed assistant turn's, ahead of its tool call.
    expect(md.match(/need a search/g)?.length).toBe(1);
    expect(md.indexOf('need a search')).toBeLessThan(md.indexOf('`search` (call_1)'));
    expect(md).toContain('found it');
    expect(md).toContain('here you go');
    expect(md).toContain('> round 1 · tokens: prompt=10 completion=5 total=15 · elapsed: 2.0s');
    expect(md).toContain('> round 2 · tokens: prompt=20 completion=3 total=23 · elapsed: 1.0s');
  });

  it('keeps a history reply\'s replayed reasoning out of the transcript', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 900,
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: '[speaker:甲:10000001] 昨天聊的那个呢' },
        { role: 'assistant', content: '在这', reasoning_content: 'earlier turn thinking about 乙 的问题' },
        { role: 'user', content: '<current_query>\n当前问题：q\n</current_query>' },
      ],
      response: { text: 'now', reasoningContent: 'this turn thinking' },
      turnKey: 'msg:history',
    });

    const md = readTurnFile('msg-history');
    expect(md).not.toContain('earlier turn thinking');
    // This turn's own thinking still renders, once, after the request.
    expect(md.match(/### ⟵ thinking/g)?.length).toBe(1);
    expect(md).toContain('this turn thinking');
  });

  it('lifts the time and speaker labels onto the entry header line', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 1234,
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: '[8/27 11:05] [speaker:Alice:1001] 并非特效' },
        { role: 'assistant', content: '[8/27 11:06] first para\n\nsecond para' },
        { role: 'user', content: '<current_query>\n当前问题：q\n</current_query>' },
      ],
      response: { text: 'ok' },
      turnKey: 'msg:labels',
    });

    const md = readTurnFile('msg-labels');
    expect(md).toContain('========== user [speaker:Alice:1001] 8/27 11:05 ==========\n并非特效');
    // The ruled header is the separator, so a blank line inside a body stays verbatim
    // instead of splitting the entry into two phantom messages.
    expect(md).toContain('========== assistant 8/27 11:06 ==========\nfirst para\n\nsecond para');
  });

  it('breaks the assembled request envelope out of the transcript', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 1234,
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: '[8/27 11:05] [speaker:Alice:1001] 并非特效' },
        {
          role: 'user',
          content:
            '<memory_context>\ngroup rules\n</memory_context>\n\n<rag_context>\ncygnus: 七夕都收了不少钱吧\n</rag_context>\n\n<current_query>\n当前问题：宝宝也会星期四文案了嘛\n</current_query>',
        },
      ],
      response: { text: 'ok' },
      turnKey: 'msg:envelope',
    });

    const md = readTurnFile('msg-envelope');
    expect(md).toContain('### request envelope');
    expect(md).toContain('#### memory_context');
    expect(md).toContain('#### rag_context');
    expect(md).toContain('#### current_query');
    // Retrieved chat lines must not land in the transcript as if someone had said them.
    const transcript = md.slice(md.indexOf('### conversation'), md.indexOf('### request envelope'));
    expect(transcript).not.toContain('cygnus');
  });

  it('leaves a body that opens with a bracket alone', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 1234,
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: '[8/27 11:05] [speaker:Alice:1001] [Reply:153474] 宝宝也会星期四文案了嘛' },
        { role: 'user', content: '<current_query>\nq\n</current_query>' },
      ],
      response: { text: 'ok' },
      turnKey: 'msg:brackets',
    });

    const md = readTurnFile('msg-brackets');
    // [Reply:…] is message content, not one of the assembler's labels.
    expect(md).toContain('========== user [speaker:Alice:1001] 8/27 11:05 ==========\n[Reply:153474] 宝宝也会星期四文案了嘛');
  });

  it('finds the envelope behind the user turns tool rounds append after it', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 1234,
      provider: 'deepseek',
      prompt: '',
      messages: [
        { role: 'user', content: '[8/27 11:05] [speaker:Alice:1001] 看看这张图' },
        { role: 'user', content: '<memory_context>\ngroup rules\n</memory_context>\n\n<current_query>\nq\n</current_query>' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'search', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'results' },
        // generateWithTools appends this user turn AFTER the envelope.
        { role: 'user', content: '[以下是工具获取的图片的AI视觉分析结果，请结合此分析进行回复]\n一只猫' },
      ],
      response: { text: 'ok' },
      turnKey: 'msg:afterenvelope',
    });

    const md = readTurnFile('msg-afterenvelope');
    expect(md).toContain('#### memory_context');
    // The injected turn is dialogue, not the envelope; the envelope keeps its chapter.
    expect(md).toContain('一只猫');
    expect(md.indexOf('### request envelope')).toBeLessThan(md.indexOf('一只猫'));
    expect(md.match(/### request envelope/g)).toHaveLength(1);
  });

  it('renders an envelope that is not built from tag sections whole', () => {
    const plugin = makePlugin();
    emit(plugin, {
      opLabel: 'generate',
      durationMs: 1234,
      provider: 'deepseek',
      prompt: '',
      messages: [{ role: 'user', content: '<current_query>plain final turn</current_query>' }],
      response: { text: 'ok' },
      turnKey: 'msg:rawenvelope',
    });

    const md = readTurnFile('msg-rawenvelope');
    expect(md).toContain('### request envelope');
    expect(md).toContain('#### current_query');
    expect(md).toContain('plain final turn');
  });

  it('falls back to a background file when no turn key is present', () => {
    const plugin = makePlugin();
    emit(plugin, { opLabel: 'generateLite', durationMs: 820, provider: 'groq', prompt: 'classify', response: { text: 'quick' } });
    const md = readTurnFile('background');
    expect(md).toContain('classify');
    expect(md).toContain('quick');
    // No usage reported: the stats line still carries elapsed, sub-second in ms.
    expect(md).toContain('> round 1 · elapsed: 820ms');
  });
});
