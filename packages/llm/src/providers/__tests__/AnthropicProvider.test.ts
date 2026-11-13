// The Anthropic API requires the assistant turn carrying tool_use blocks to be echoed
// back exactly as received — thinking blocks (text + signature) included. A mapper that
// rebuilds the turn from text + tool_calls alone silently drops the model's reasoning
// state between tool rounds, so it re-derives its plan on every round.

import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../../types';
import { AnthropicProvider } from '../AnthropicProvider';

interface CapturedBody {
  messages: Array<{ role: string; content: unknown }>;
}

/** Stub the HTTP layer: no network, canned response, request bodies captured. */
function providerReturning(response: unknown): { provider: AnthropicProvider; bodies: CapturedBody[] } {
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-6' });
  const bodies: CapturedBody[] = [];
  (provider as unknown as { httpClient: { post: (path: string, body: unknown) => Promise<unknown> } }).httpClient = {
    post: async (_path: string, body: unknown) => {
      bodies.push(body as CapturedBody);
      return response;
    },
  };
  return { provider, bodies };
}

const THINKING_BLOCK = { type: 'thinking', thinking: 'need the weather tool', signature: 'sig-abc' } as const;
const REDACTED_BLOCK = { type: 'redacted_thinking', data: 'enc-payload' } as const;

describe('AnthropicProvider thinking round-trip', () => {
  it('surfaces thinking blocks verbatim on the response for echo-back', async () => {
    const { provider } = providerReturning({
      content: [
        THINKING_BLOCK,
        REDACTED_BLOCK,
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'Paris' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
    });

    const res = await provider.generate('天气如何');

    expect(res.thinkingBlocks).toEqual([THINKING_BLOCK, REDACTED_BLOCK]);
    expect(res.reasoningContent).toBe('need the weather tool');
    expect(res.functionCalls).toHaveLength(1);
  });

  it('replays thinking blocks ahead of text/tool_use when the turn is echoed back', async () => {
    const { provider, bodies } = providerReturning({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: '天气如何' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [{ id: 'toolu_1', name: 'get_weather', arguments: '{"location":"Paris"}' }],
        provider: 'anthropic',
        reasoning_content: 'need the weather tool',
        thinking_blocks: [THINKING_BLOCK, REDACTED_BLOCK],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"temp":20}' },
    ];

    await provider.generate('', { messages });

    const assistantTurn = bodies[0].messages.find((m) => m.role === 'assistant');
    expect(assistantTurn?.content).toEqual([
      THINKING_BLOCK,
      REDACTED_BLOCK,
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'Paris' } },
    ]);
  });

  it('does not fabricate thinking blocks for a foreign tool_calls turn', async () => {
    const { provider, bodies } = providerReturning({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const messages: ChatMessage[] = [
      { role: 'user', content: '天气如何' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: '{}' }],
        provider: 'deepseek',
        reasoning_content: 'foreign reasoning text',
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
    ];

    await provider.generate('', { messages });

    const assistantTurn = bodies[0].messages.find((m) => m.role === 'assistant');
    const blocks = assistantTurn?.content as Array<{ type: string }>;
    expect(blocks[0].type).toBe('text');
    expect(blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')).toBe(false);
  });
});

describe('AnthropicProvider usage', () => {
  it('counts cache reads and writes into the prompt and reports the reads as cached', async () => {
    const { provider } = providerReturning({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 900 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const res = await provider.generate('hi');

    expect(res.usage).toEqual({
      promptTokens: 10_000,
      completionTokens: 20,
      totalTokens: 10_020,
      cachedPromptTokens: 9_000,
    });
  });
});

/** Stub the HTTP layer with one canned response per call, in order. */
function providerReturningSequence(responses: unknown[]): AnthropicProvider {
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-6' });
  let call = 0;
  (provider as unknown as { httpClient: { post: () => Promise<unknown> } }).httpClient = {
    post: async () => responses[call++],
  };
  return provider;
}

describe('AnthropicProvider unfinished turns', () => {
  it('fails a refusal that cut the text mid-sentence instead of returning the fragment', async () => {
    const { provider } = providerReturning({
      content: [{ type: 'text', text: '第一点说完了。第二点是这个句子没有说' }],
      usage: { input_tokens: 10, output_tokens: 114 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'refusal',
    });

    await expect(provider.generate('问题')).rejects.toThrow('stop_reason=refusal');
  });

  it('names the stop reason when the turn produced nothing', async () => {
    const { provider } = providerReturning({
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'max_tokens',
    });

    await expect(provider.generate('问题')).rejects.toThrow('stop_reason=max_tokens');
  });

  it('returns the text written before max_tokens', async () => {
    const { provider } = providerReturning({
      content: [{ type: 'text', text: '一段写到预算上限的长回答' }],
      usage: { input_tokens: 10, output_tokens: 2000 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'max_tokens',
    });

    const res = await provider.generate('问题');

    expect(res.text).toBe('一段写到预算上限的长回答');
  });

  it('keeps the text written before a pause_turn', async () => {
    const provider = providerReturningSequence([
      {
        content: [{ type: 'text', text: '先查一下。' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'pause_turn',
      },
      {
        content: [{ type: 'text', text: '查到了。' }],
        usage: { input_tokens: 12, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      },
    ]);

    const res = await provider.generate('问题');

    expect(res.text).toBe('先查一下。\n查到了。');
  });
});
