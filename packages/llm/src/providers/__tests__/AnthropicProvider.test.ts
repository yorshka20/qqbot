// The Anthropic API requires the assistant turn carrying tool_use blocks to be echoed
// back exactly as received — thinking blocks (text + signature) included. A mapper that
// rebuilds the turn from text + tool_calls alone silently drops the model's reasoning
// state between tool rounds, so it re-derives its plan on every round.

import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../../types';
import { ProviderRefusalError } from '../../errors';
import { AnthropicProvider } from '../AnthropicProvider';

interface CapturedBody {
  messages: Array<{ role: string; content: unknown }>;
  max_tokens: number;
  fallbacks?: unknown;
}

const MODEL_OUTPUT_CEILING = 64_000;

/**
 * Stub the HTTP layer: no network, canned response, request bodies captured. `get` is
 * the Models API lookup of the model's output ceiling; `modelLookups` counts it.
 */
function providerReturning(response: unknown): {
  provider: AnthropicProvider;
  bodies: CapturedBody[];
  modelLookups: string[];
} {
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-6' });
  const bodies: CapturedBody[] = [];
  const modelLookups: string[] = [];
  (provider as unknown as { httpClient: object }).httpClient = {
    get: async (path: string) => {
      modelLookups.push(path);
      return { max_tokens: MODEL_OUTPUT_CEILING };
    },
    post: async (_path: string, body: unknown) => {
      bodies.push(body as CapturedBody);
      return response;
    },
  };
  return { provider, bodies, modelLookups };
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
  (provider as unknown as { httpClient: object }).httpClient = {
    get: async () => ({ max_tokens: MODEL_OUTPUT_CEILING }),
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

  it('reports a refusal as a ProviderRefusalError carrying the category and explanation', async () => {
    const { provider } = providerReturning({
      content: [],
      usage: { input_tokens: 10, output_tokens: 0 },
      model: 'claude-opus-5-5',
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'frontier_llm', explanation: 'could assist model development' },
    });

    const error = await provider.generate('问题').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderRefusalError);
    expect(error).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', category: 'frontier_llm' });
    expect((error as Error).message).toContain('category=frontier_llm');
    expect((error as Error).message).toContain('could assist model development');
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

describe('AnthropicProvider refusal fallback', () => {
  it('asks the API to re-run a declined request on its recommended fallback model', async () => {
    const { provider, bodies } = providerReturning({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    await provider.generate('问题');

    expect(bodies[0].fallbacks).toBe('default');
  });

  it('returns what the fallback model wrote and names it as the serving model', async () => {
    const { provider } = providerReturning({
      content: [
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
        THINKING_BLOCK,
        { type: 'text', text: '换了个模型回答' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
    });

    const res = await provider.generate('问题', { model: 'claude-opus-5-5' });

    expect(res.text).toBe('换了个模型回答');
    expect(res.resolvedModel).toBe('claude-opus-5');
    expect(res.thinkingBlocks).toEqual([THINKING_BLOCK]);
  });
});

describe('AnthropicProvider output budget', () => {
  it("requests the model's own output ceiling, looked up once per model", async () => {
    const { provider, bodies, modelLookups } = providerReturning({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    await provider.generate('一');
    await provider.generate('二');

    expect(bodies.map((body) => body.max_tokens)).toEqual([MODEL_OUTPUT_CEILING, MODEL_OUTPUT_CEILING]);
    expect(modelLookups).toEqual(['/models/claude-sonnet-4-6']);
  });

  it('honours a smaller explicit budget', async () => {
    const { provider, bodies } = providerReturning({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    await provider.generate('问题', { maxTokens: 300 });

    expect(bodies[0].max_tokens).toBe(300);
  });
});
