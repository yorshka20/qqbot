import { describe, expect, it } from 'bun:test';
import type { VisionImage } from '../../capabilities/types';
import { AnthropicProvider } from '../AnthropicProvider';
import { DeepSeekProvider } from '../DeepSeekProvider';
import { DoubaoProvider } from '../DoubaoProvider';
import { LaozhangProvider } from '../LaozhangProvider';
import { MinimaxProvider } from '../MinimaxProvider';
import { OpenAIProvider } from '../OpenAIProvider';

// 1x1 PNG
const IMAGE: VisionImage = {
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
};

function fakeHttp(provider: object, response: unknown): void {
  (provider as { httpClient: unknown }).httpClient = { post: async () => response };
}

describe('generateWithVision reports the model it sent', () => {
  it('Anthropic', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-default' });
    fakeHttp(provider, { content: [{ type: 'text', text: 'ok' }], model: 'claude-default', usage: { input_tokens: 1, output_tokens: 1 } });
    const res = await provider.generateWithVision('看图', [IMAGE], { model: 'claude-vision' });
    expect(res.resolvedModel).toBe('claude-vision');
  });

  it('DeepSeek', async () => {
    const provider = new DeepSeekProvider({ type: 'deepseek', apiKey: 'test-key', model: 'deepseek-default' } as never);
    fakeHttp(provider, { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], model: 'deepseek-default' });
    const res = await provider.generateWithVision('看图', [IMAGE], { model: 'deepseek-vision' });
    expect(res.resolvedModel).toBe('deepseek-vision');
  });

  it('Doubao', async () => {
    const provider = new DoubaoProvider({ apiKey: 'test-key', model: 'doubao-default' } as never);
    fakeHttp(provider, { model: 'doubao-default', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    const res = await provider.generateWithVision('看图', [IMAGE], { model: 'doubao-vision' });
    expect(res.resolvedModel).toBe('doubao-vision');
  });

  it('Minimax', async () => {
    const provider = new MinimaxProvider({ apiKey: 'test-key', model: 'minimax-default' });
    fakeHttp(provider, { id: 'r1', model: 'minimax-default', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] });
    const res = await provider.generateWithVision('看图', [IMAGE], { model: 'minimax-vision' });
    expect(res.resolvedModel).toBe('minimax-vision');
  });

  it('OpenAI', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'openai-default' });
    (provider as unknown as { client: unknown }).client = {
      responses: {
        create: async () => ({ model: 'openai-default', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }),
      },
    };
    const res = await provider.generateWithVision('看图', [IMAGE], { model: 'openai-vision' });
    expect(res.resolvedModel).toBe('openai-vision');
  });

  it('Laozhang uses its vision model, not the llm one', async () => {
    const provider = new LaozhangProvider({
      apiKey: 'test-key',
      llm: { model: 'laozhang-llm' },
      vision: { model: 'laozhang-vision' },
    } as never);
    fakeHttp(provider, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    const res = await provider.generateWithVision('看图', [IMAGE]);
    expect(res.resolvedModel).toBe('laozhang-vision');
  });
});
