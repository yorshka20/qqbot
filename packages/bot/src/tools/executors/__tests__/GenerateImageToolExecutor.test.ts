import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { AIService } from '@/ai';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { GenerateImageToolExecutor } from '../GenerateImageToolExecutor';

function executorWith(aiService: Partial<AIService>): GenerateImageToolExecutor {
  return new GenerateImageToolExecutor(
    aiService as AIService,
    { sendFromContext: async () => ({ message_seq: 1 }) } as unknown as MessageAPI,
    {} as DatabaseManager,
  );
}

function contextWith(imageUrls: string[]): ToolExecutionContext {
  return {
    userId: 1,
    messageType: 'group',
    hookContext: {
      message: {
        id: 'm1',
        type: 'message',
        timestamp: 0,
        protocol: 'milky',
        messageType: 'group',
        userId: 1,
        message: '',
        segments: imageUrls.map((url) => ({ type: 'image', data: { uri: url } })),
      },
      metadata: { get: () => undefined, set: () => undefined },
    },
  } as unknown as ToolExecutionContext;
}

const call = (parameters: Record<string, unknown>): ToolCall => ({
  type: 'generate_image',
  executor: 'generate_image',
  parameters,
});

describe('generate_image reference inputs', () => {
  it('forwards every message image and the cited presets to img2img', async () => {
    const seen: { images: string[]; options: unknown; provider?: string }[] = [];
    const executor = executorWith({
      generateImageFromImage: async (_ctx, images, _prompt, options, providerName) => {
        seen.push({ images, options, provider: providerName });
        return { images: [{ url: 'https://example.com/out.png' }] };
      },
    });

    const result = await executor.execute(
      call({
        prompt: '站在窗边',
        provider: 'openai',
        presets: ['hero', ' hero ', 'outfit'],
      }),
      contextWith(['https://example.com/a.png', 'https://example.com/b.png']),
    );

    expect(result.success).toBe(true);
    expect(seen[0]?.provider).toBe('openai');
    expect(seen[0]?.images).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
    expect(seen[0]?.options).toMatchObject({ model: 'gpt-image-2', presetIds: ['hero', 'outfit'] });
  });

  it('uses img2img for presets even when the message has no image, including the gemini provider', async () => {
    const seen: { images: string[]; provider?: string; options: unknown }[] = [];
    const executor = executorWith({
      generateImg: async () => {
        throw new Error('text2img should not run');
      },
      generateImageFromImage: async (_ctx, images, _prompt, options, providerName) => {
        seen.push({ images, provider: providerName, options });
        return { images: [{ url: 'https://example.com/out.png' }] };
      },
    });

    const result = await executor.execute(call({ prompt: '新姿势', presets: ['hero'] }), contextWith([]));

    expect(result.success).toBe(true);
    expect(seen[0]?.provider).toBe('laozhang');
    expect(seen[0]?.images).toEqual([]);
    expect(seen[0]?.options).toMatchObject({ presetIds: ['hero'] });
  });

  it('keeps text2img when there is no message image and no preset', async () => {
    let text2img = 0;
    const executor = executorWith({
      generateImg: async () => {
        text2img += 1;
        return { images: [{ url: 'https://example.com/out.png' }] };
      },
      generateImageFromImage: async () => {
        throw new Error('img2img should not run');
      },
    });

    const result = await executor.execute(call({ prompt: '一只猫' }), contextWith([]));
    expect(result.success).toBe(true);
    expect(text2img).toBe(1);
  });
});
