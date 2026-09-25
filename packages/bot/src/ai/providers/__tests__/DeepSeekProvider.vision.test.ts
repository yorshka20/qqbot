import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import type { DeepSeekProviderConfig } from '@/core/config/types/ai';
import type { ChatMessage, ContentPart } from '../../types';
import { DeepSeekProvider } from '../DeepSeekProvider';

interface RequestBody {
  messages: Array<{ role: string; content: string | ContentPart[] }>;
}

/** Stub the HTTP layer so no network is hit; returns the body the provider sent. */
function providerRecordingBody(): { provider: DeepSeekProvider; lastBody: () => RequestBody } {
  const provider = new DeepSeekProvider({
    type: 'deepseek',
    apiKey: 'test-key',
    model: 'deepseek-flash',
  } as DeepSeekProviderConfig);
  let body: RequestBody | undefined;
  (provider as unknown as { httpClient: { post: (path: string, b: RequestBody) => Promise<unknown> } }).httpClient = {
    post: async (_path, b) => {
      body = b;
      return {
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        model: 'deepseek-flash',
      };
    },
  };
  return {
    provider,
    lastBody: () => {
      if (!body) throw new Error('no request was sent');
      return body;
    },
  };
}

const IMAGE_PART: ContentPart = {
  type: 'image_url',
  image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
};

describe('DeepSeekProvider vision', () => {
  it('declares the vision capability', () => {
    const { provider } = providerRecordingBody();
    expect(provider.getCapabilities()).toContain('vision');
  });

  it('sends a user turn with its image parts intact', async () => {
    const { provider, lastBody } = providerRecordingBody();
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, IMAGE_PART] }];

    await provider.generate('', { messages });

    expect(lastBody().messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '这是什么' }, IMAGE_PART] },
    ]);
  });

  it('flattens images out of system and assistant turns, which the API rejects', async () => {
    const { provider, lastBody } = providerRecordingBody();
    const messages: ChatMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'persona' }, IMAGE_PART] },
      { role: 'assistant', content: [{ type: 'text', text: '我发过一张图' }, IMAGE_PART] },
      { role: 'user', content: '还记得吗' },
    ];

    await provider.generate('', { messages });

    expect(lastBody().messages).toEqual([
      { role: 'system', content: 'persona\n[Image]' },
      { role: 'assistant', content: '我发过一张图\n[Image]' },
      { role: 'user', content: '还记得吗' },
    ]);
  });

  it('builds the user turn from prompt + images for generateWithVision', async () => {
    const { provider, lastBody } = providerRecordingBody();

    await provider.generateWithVision('描述这张图', [{ base64: 'aW1hZ2U=', mimeType: 'image/png' }], {
      systemPrompt: 'persona',
    });

    expect(lastBody().messages).toEqual([
      { role: 'system', content: 'persona' },
      { role: 'user', content: [{ type: 'text', text: '描述这张图' }, IMAGE_PART] },
    ]);
  });
});
