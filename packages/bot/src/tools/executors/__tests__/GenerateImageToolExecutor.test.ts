import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { AIService } from '@/ai';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { describeGenerateImageForModel, GenerateImageToolExecutor } from '../GenerateImageToolExecutor';

function executorWith(aiService: Partial<AIService>): GenerateImageToolExecutor {
  return new GenerateImageToolExecutor(
    aiService as AIService,
    { sendFromContext: async () => ({ message_seq: 1 }) } as unknown as MessageAPI,
    {} as DatabaseManager,
    { appendBotMessageToSession: async () => {} } as unknown as ConversationHistoryService,
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
    expect(seen[0]?.options).not.toHaveProperty('aspectRatio');
  });

  it('sends OpenAI a pixel size and Gemini an aspect ratio', async () => {
    const seen: { provider?: string; options: unknown }[] = [];
    const executor = executorWith({
      generateImageFromImage: async (_ctx, _images, _prompt, options, providerName) => {
        seen.push({ provider: providerName, options });
        return { images: [{ url: 'https://example.com/out.png' }] };
      },
    });

    await executor.execute(
      call({ prompt: '竖向四格', provider: 'openai', presets: ['hero'], aspect_ratio: '9:16', size: '1024x1536' }),
      contextWith([]),
    );
    await executor.execute(
      call({ prompt: '竖向四格', provider: 'gemini', presets: ['hero'], aspect_ratio: '9:16', size: '1024x1536' }),
      contextWith([]),
    );

    expect(seen[0]?.provider).toBe('openai');
    expect(seen[0]?.options).toMatchObject({ imageSize: '1024x1536' });
    expect(seen[0]?.options).not.toHaveProperty('aspectRatio');
    expect(seen[1]?.provider).toBe('laozhang');
    expect(seen[1]?.options).toMatchObject({ aspectRatio: '9:16' });
    expect(seen[1]?.options).not.toHaveProperty('imageSize');
  });

  it('uses img2img for presets even when the message has no image, on the default openai provider', async () => {
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
    expect(seen[0]?.provider).toBe('openai');
    expect(seen[0]?.images).toEqual([]);
    expect(seen[0]?.options).toMatchObject({ model: 'gpt-image-2', presetIds: ['hero'] });
  });

  it('sends the tool prompt straight to text2img without another LLM pass', async () => {
    const seen: { prompt?: string; skipLLMProcess?: boolean; templateName?: string }[] = [];
    const executor = executorWith({
      generateImg: async (_ctx, options, _provider, skipLLMProcess, templateName) => {
        seen.push({ prompt: options.prompt, skipLLMProcess, templateName });
        return { images: [{ url: 'https://example.com/out.png' }] };
      },
      generateImageFromImage: async () => {
        throw new Error('img2img should not run');
      },
    });

    const result = await executor.execute(call({ prompt: '一只橘猫坐在窗台上，午后阳光' }), contextWith([]));
    expect(result.success).toBe(true);
    expect(seen).toEqual([{ prompt: '一只橘猫坐在窗台上，午后阳光', skipLLMProcess: true, templateName: undefined }]);
  });
});

describe('describeGenerateImageForModel', () => {
  it('tells the model to cite a preset id the task names, not only a spoken alias', () => {
    const description = describeGenerateImageForModel().parameterOverrides?.presets?.description ?? '';
    expect(description).toContain('deepseek-q');
    expect(description).toContain('任务');
  });
});
