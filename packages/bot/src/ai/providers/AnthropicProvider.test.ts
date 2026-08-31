// The Anthropic API requires the assistant turn carrying tool_use blocks to be echoed
// back exactly as received — thinking blocks (text + signature) included. A mapper that
// rebuilds the turn from text + tool_calls alone silently drops the model's reasoning
// state between tool rounds, so it re-derives its plan on every round.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../types';
import { AnthropicProvider } from './AnthropicProvider';

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
