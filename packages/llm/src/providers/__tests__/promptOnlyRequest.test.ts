// A provider sends exactly what its caller gave it. For a bare prompt that means the
// system prompt and that one user turn — never conversation history it fetched for
// itself, whatever `sessionId` rides along. History belongs to the caller: a reply
// path that wants it renders it into the prompt or passes it as `messages`.

import { describe, expect, it } from 'bun:test';
import type { GeminiProviderConfig, LaozhangProviderConfig, OpenRouterProviderConfig } from '../../config';
import type { AIProvider } from '../../base/AIProvider';
import type { LLMCapability } from '../../capabilities/LLMCapability';
import type { AIGenerateOptions } from '../../types';
import { AnthropicProvider } from '../AnthropicProvider';
import { DeepSeekProvider } from '../DeepSeekProvider';
import { DoubaoProvider } from '../DoubaoProvider';
import { GeminiProvider } from '../GeminiProvider';
import { GroqProvider } from '../GroqProvider';
import { LaozhangProvider } from '../LaozhangProvider';
import { MinimaxProvider } from '../MinimaxProvider';
import { OllamaProvider } from '../OllamaProvider';
import { OpenAIProvider } from '../OpenAIProvider';
import { OpenRouterProvider } from '../OpenRouterProvider';
import { SiliconFlowProvider } from '../SiliconFlowProvider';

const SYSTEM = 'You are a test assistant.';
const PROMPT = 'Render the image prompt for: 测试用户甲 asked for a cat';
const OPTIONS: AIGenerateOptions = { systemPrompt: SYSTEM, sessionId: 'group:10000001', reasoningEffort: 'none' };

type Turn = { role: string; content: unknown };

/** The request never needs to succeed: capture it, then abort the call. */
const CAPTURED = new Error('request captured');

function captureHttpPost(provider: AIProvider): unknown[] {
  const bodies: unknown[] = [];
  (provider as unknown as { httpClient: { post: (path: string, body: unknown) => Promise<unknown> } }).httpClient = {
    post: async (_path, body) => {
      bodies.push(body);
      throw CAPTURED;
    },
  };
  return bodies;
}

async function send(provider: AIProvider & LLMCapability): Promise<void> {
  await provider.generate(PROMPT, OPTIONS).catch((err) => {
    if (err !== CAPTURED && !String(err).includes(CAPTURED.message)) {
      throw err;
    }
  });
}

const systemThenPrompt: Turn[] = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: PROMPT },
];

describe('bare prompt reaches the wire as system prompt + that prompt only', () => {
  const chatCompletions: Array<[string, () => AIProvider & LLMCapability]> = [
    ['deepseek', () => new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-v4-pro' })],
    ['groq', () => new GroqProvider({ apiKey: 'k', model: 'openai/gpt-oss-20b' })],
    ['siliconflow', () => new SiliconFlowProvider({ apiKey: 'k', model: 'Qwen/Qwen3-8B' })],
    [
      'openrouter',
      () => new OpenRouterProvider({ type: 'openrouter', apiKey: 'k', model: 'x/y' } as OpenRouterProviderConfig),
    ],
    ['ollama', () => new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'qwen3' })],
  ];

  for (const [name, make] of chatCompletions) {
    it(name, async () => {
      const provider = make();
      const bodies = captureHttpPost(provider);
      await send(provider);
      expect((bodies[0] as { messages: Turn[] }).messages).toEqual(systemThenPrompt);
    });
  }

  it('minimax', async () => {
    const provider = new MinimaxProvider({ apiKey: 'k', model: 'MiniMax-M2.7' });
    const bodies = captureHttpPost(provider);
    await send(provider);
    const turns = (bodies[0] as { messages: Turn[] }).messages.filter((m) => m.role !== 'system');
    expect(turns).toEqual([{ role: 'user', content: PROMPT }]);
  });

  it('anthropic', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5' });
    const bodies = captureHttpPost(provider);
    await send(provider);
    expect((bodies[0] as { messages: Turn[] }).messages).toEqual([{ role: 'user', content: PROMPT }]);
  });

  it('doubao', async () => {
    const provider = new DoubaoProvider({ apiKey: 'k', model: 'doubao-seed-2-0-pro-260215' });
    const bodies = captureHttpPost(provider);
    await send(provider);
    expect((bodies[0] as { input: Turn[] }).input).toEqual(systemThenPrompt);
  });

  it('laozhang', async () => {
    const provider = new LaozhangProvider({
      type: 'laozhang',
      apiKey: 'k',
      llm: { model: 'gemini-2.0-flash' },
    } as LaozhangProviderConfig);
    const bodies = captureHttpPost(provider);
    await send(provider);
    const texts = (bodies[0] as { contents: Array<{ parts: Array<{ text?: string }> }> }).contents.flatMap((c) =>
      c.parts.map((p) => p.text),
    );
    expect(texts).toEqual([`system: ${SYSTEM}\n\n`, PROMPT]);
  });

  it('gemini', async () => {
    const provider = new GeminiProvider({
      type: 'gemini',
      apiKey: 'k',
      llm: { model: 'gemini-3-flash-preview' },
    } as GeminiProviderConfig);
    const requests: Array<{ contents: unknown }> = [];
    (provider as unknown as { getClient: () => unknown }).getClient = () => ({
      models: {
        generateContent: async (req: { contents: unknown }) => {
          requests.push(req);
          throw CAPTURED;
        },
      },
    });
    await send(provider);
    expect(JSON.stringify(requests[0]?.contents)).toBe(JSON.stringify([{ text: `system: ${SYSTEM}\n\n${PROMPT}` }]));
  });

  it('openai', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'gpt-6.1-sol' });
    const requests: Array<{ input: Turn[] }> = [];
    (provider as unknown as { client: unknown }).client = {
      responses: {
        create: async (req: { input: Turn[] }) => {
          requests.push(req);
          throw CAPTURED;
        },
      },
    };
    await send(provider);
    expect(requests[0]?.input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
      { role: 'user', content: [{ type: 'input_text', text: PROMPT }] },
    ]);
  });
});
