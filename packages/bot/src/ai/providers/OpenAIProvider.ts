// OpenAI Provider implementation

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI, { toFile } from 'openai';
import type { OpenAIImageConfig } from '@/core/config/types/ai';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { AIProvider } from '../base/AIProvider';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { LLMCapability } from '../capabilities/LLMCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2ImageOptions,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
  VisionImage,
} from '../capabilities/types';
import type { VisionCapability } from '../capabilities/VisionCapability';
import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatCompletionMessageParam,
  ChatMessage,
  ChatMessageRoleBase,
  StreamingHandler,
} from '../types';
import { ResourceDownloader } from '../utils/ResourceDownloader';

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  enableContext?: boolean;
  contextMessageCount?: number;
  image?: OpenAIImageConfig;
}

const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

/**
 * OpenAI Provider implementation
 * Implements LLM and Vision capabilities
 * Supports GPT-4 Vision models for multimodal input
 */
export class OpenAIProvider
  extends AIProvider
  implements LLMCapability, VisionCapability, Text2ImageCapability, Image2ImageCapability
{
  readonly name = 'openai';
  override readonly supportsToolUse = true;
  private client: OpenAI | null = null;
  private config: OpenAIProviderConfig;
  private _capabilities: CapabilityType[];

  private outputPath = join(getRepoRoot(), 'output', 'openai');

  constructor(config: OpenAIProviderConfig) {
    super();
    this.config = config;

    // Explicitly declare supported capabilities
    // OpenAI supports LLM and Vision (GPT-4 Vision models) by default;
    // text2img + img2img (gpt-image-2) are opt-in via `image.enabled`.
    this._capabilities = ['llm', 'function_calling', 'vision'];
    if (config.image?.enabled) {
      this._capabilities.push('text2img', 'img2img');
    }

    // Set context configuration
    this.setContextConfig(config.enableContext ?? false, config.contextMessageCount ?? 10);

    if (this.isAvailable()) {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
      logger.info('[OpenAIProvider] Initialized');
    }
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable() || !this.client) {
      return false;
    }

    try {
      // Test API connection by making a simple request
      await this.client.models.list();
      return true;
    } catch (error) {
      logger.debug('[OpenAIProvider] Availability check failed:', error);
      return false;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      model: this.config.model || 'gpt-3.5-turbo',
      defaultTemperature: this.config.defaultTemperature || 0.7,
      defaultMaxTokens: this.config.defaultMaxTokens || 2000,
    };
  }

  /**
   * Get capabilities supported by this provider
   * OpenAI supports LLM text generation and Vision (multimodal)
   */
  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Map ChatMessage[] to OpenAI API format (supports tool role and assistant tool_calls)
   */
  private mapMessagesToOpenAI(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id ?? '',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant' as const,
          content: m.content ?? '',
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return {
        role: m.role as ChatMessageRoleBase,
        content: m.content ?? '',
      };
    }) as ChatCompletionMessageParam[];
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = options?.model ?? this.config.model ?? 'gpt-3.5-turbo';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating with model: ${model}`);

      let messages: ChatCompletionMessageParam[];
      if (options?.messages?.length) {
        messages = this.mapMessagesToOpenAI(options.messages);
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        if (options?.systemPrompt) {
          messages.push({ role: 'system', content: options.systemPrompt });
        }
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
            content: msg.content,
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
      };

      if (options?.jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      if (options?.tools?.length) {
        body.tools = options.tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
        body.tool_choice = 'auto';
      }

      const response = await this.client.chat.completions.create(body);

      const msg = response.choices[0]?.message;
      const text = msg?.content ?? (typeof msg?.content === 'string' ? msg.content : '') ?? '';
      const usage = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      const result: AIGenerateResponse = {
        text,
        usage,
        metadata: {
          model: response.model,
          finishReason: response.choices[0]?.finish_reason,
        },
      };

      const toolCalls = msg?.tool_calls;
      if (toolCalls?.length) {
        result.functionCalls = [];
        for (const tc of toolCalls) {
          const fn = tc.type === 'function' ? tc.function : undefined;
          if (fn) {
            result.functionCalls.push({
              name: fn.name ?? '',
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
              toolCallId: tc.id ?? undefined,
            });
          }
        }
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Generation failed:', err);
      throw err;
    }
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = options?.model ?? this.config.model ?? 'gpt-3.5-turbo';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating stream with model: ${model}`);

      let messages: ChatCompletionMessageParam[];
      if (options?.messages?.length) {
        messages = options.messages.map((m) => ({ role: m.role, content: m.content })) as ChatCompletionMessageParam[];
      } else {
        const history = await this.loadHistory(options);
        messages = [];
        if (options?.systemPrompt) {
          messages.push({ role: 'system', content: options.systemPrompt });
        }
        for (const msg of history) {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
            content: msg.content,
          });
        }
        messages.push({
          role: 'user',
          content: prompt,
        });
      }

      const streamBody: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
      };
      if (options?.jsonMode) {
        streamBody.response_format = { type: 'json_object' };
      }
      const stream = await this.client.chat.completions.create(streamBody);

      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          handler(content);
        }

        // Capture usage if available
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }

      return {
        text: fullText,
        usage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Stream generation failed:', err);
      throw err;
    }
  }

  /**
   * Generate from full messages (history + current). Content can be string or ContentPart[].
   */
  async generateWithVisionMessages(messages: ChatMessage[], options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }
    const model = options?.model ?? this.config.model ?? 'gpt-4-vision-preview';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;
    const apiMessages = messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>),
    })) as ChatCompletionMessageParam[];
    const response = await this.client.chat.completions.create({
      model,
      messages: apiMessages,
      temperature,
      max_completion_tokens: maxTokens,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stop,
    });
    const text = response.choices[0]?.message?.content || '';
    return {
      text,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      metadata: {
        model: response.model,
        finishReason: response.choices[0]?.finish_reason,
      },
    };
  }

  /**
   * Generate text with vision (multimodal input)
   * Supports GPT-4 Vision models
   */
  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = options?.model ?? this.config.model ?? 'gpt-4-vision-preview';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: prompt },
      ];

      // Add images to content
      for (const image of images) {
        let imageUrl: string;
        if (image.url) {
          imageUrl = image.url;
        } else if (image.base64) {
          // Convert base64 to data URL
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.file) {
          // For file paths, we need to convert to base64 or URL
          // This is a simplified version - in production, you might want to handle file uploads
          throw new Error('File path images not directly supported. Please use URL or base64.');
        } else {
          throw new Error('Invalid image format. Must provide url, base64, or file.');
        }

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      const messages: Array<
        | { role: 'system'; content: string }
        | {
            role: 'user';
            content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
          }
      > = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({
        role: 'user',
        content,
      });

      const response = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
      });

      const text = response.choices[0]?.message?.content || '';
      const usage = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      return {
        text,
        usage,
        metadata: {
          model: response.model,
          finishReason: response.choices[0]?.finish_reason,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Vision generation failed:', err);
      throw err;
    }
  }

  /**
   * Explain image(s): describe image content as text. Prompt is the full rendered text from the dedicated explain-image template.
   */
  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  // ---------- Image generation (gpt-image-2) ----------

  /**
   * Save raw image bytes (base64 or Buffer) under output/openai/<ts>_<name>.
   * Returns the relative path consumed by ImageGenerationService → StaticServer URL.
   * Returns null when the file system is unavailable; callers fall back to base64.
   */
  private async saveImageToFile(imageData: Buffer | string, originalFilename: string): Promise<string | null> {
    try {
      await mkdir(this.outputPath, { recursive: true });
      const timestamp = Date.now();
      const filename = `${timestamp}_${originalFilename}`;
      const filepath = join(this.outputPath, filename);
      const imageBuffer: Buffer = imageData instanceof Buffer ? imageData : Buffer.from(imageData as string, 'base64');
      await writeFile(filepath, imageBuffer);
      logger.info(`[OpenAIProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return `openai/${filename}`;
    } catch (error) {
      logger.warn(
        `[OpenAIProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Resolve a `Text2ImageOptions.imageSize` ("1024x1024" / "auto" / WxH) to an OpenAI `size` value.
   * Falls back to the configured default, then to 'auto'.
   */
  private resolveImageSize(opts?: { imageSize?: string }): '1024x1024' | '1536x1024' | '1024x1536' | 'auto' {
    const allowed = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
    const candidate = opts?.imageSize ?? this.config.image?.size ?? 'auto';
    return allowed.has(candidate) ? (candidate as '1024x1024' | '1536x1024' | '1024x1536' | 'auto') : 'auto';
  }

  /**
   * Map a saved image (or fallback base64) into ProviderImageGenerationResponse shape.
   */
  private async buildImageEntry(base64: string, suffix: string): Promise<{ relativePath?: string; base64?: string }> {
    const ext = (this.config.image?.outputFormat ?? 'png').toLowerCase();
    const buffer = Buffer.from(base64, 'base64');
    const relativePath = await this.saveImageToFile(buffer, `${suffix}.${ext}`);
    return relativePath ? { relativePath } : { base64 };
  }

  /**
   * Text-to-image via `/v1/images/generations` (gpt-image-2 family).
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }
    const imageCfg = this.config.image;
    const model = options?.model ?? imageCfg?.model ?? DEFAULT_IMAGE_MODEL;
    const size = this.resolveImageSize(options);
    const quality = (options?.quality as OpenAIImageConfig['quality']) ?? imageCfg?.quality ?? 'auto';
    const numImages = options?.numImages && options.numImages > 0 ? Math.min(options.numImages, 10) : 1;

    try {
      logger.info(`[OpenAIProvider] generateImage | model=${model} size=${size} quality=${quality} n=${numImages}`);
      const response = await this.client.images.generate({
        model,
        prompt,
        n: numImages,
        size,
        quality,
        background: imageCfg?.background ?? 'auto',
        output_format: imageCfg?.outputFormat ?? 'png',
        output_compression: imageCfg?.outputCompression,
        moderation: imageCfg?.moderation ?? 'auto',
      });

      const images: Array<{ relativePath?: string; base64?: string }> = [];
      for (const [idx, item] of (response.data ?? []).entries()) {
        if (!item.b64_json) continue;
        images.push(await this.buildImageEntry(item.b64_json, `gen_${idx}`));
      }

      if (images.length === 0) {
        return {
          error: { code: 'no_image', message: 'OpenAI returned no image data' },
          images: [],
          metadata: { prompt, model },
        };
      }

      return {
        images,
        metadata: {
          prompt,
          model,
          size,
          quality,
          numImages,
          usage: response.usage,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] generateImage failed:', err);
      return {
        error: { code: 'generation_failed', message: err.message },
        images: [],
        text: `图片生成失败：${err.message}`,
        metadata: { prompt, model },
      };
    }
  }

  /**
   * Image-to-image via `/v1/images/edits` (gpt-image-2 family).
   * The `image` argument follows the project's VisionImage-to-string convention
   * (URL > base64 > local file path); we always convert to a Buffer first so the
   * SDK's multipart upload sees an `Uploadable` regardless of source.
   */
  async generateImageFromImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }
    const imageCfg = this.config.image;
    const model = options?.model ?? imageCfg?.model ?? DEFAULT_IMAGE_MODEL;
    const size = this.resolveImageSize(options);
    const quality = imageCfg?.quality ?? 'auto';

    try {
      const buffer = await this.loadImageToBuffer(image);
      const ext = imageCfg?.outputFormat ?? 'png';
      const mime = ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      const upload = await toFile(buffer, `input.${ext}`, { type: mime });

      logger.info(`[OpenAIProvider] generateImageFromImage | model=${model} size=${size} quality=${quality}`);
      const response = await this.client.images.edit({
        model,
        image: upload,
        prompt,
        n: 1,
        size,
        quality,
        background: imageCfg?.background ?? 'auto',
        output_format: imageCfg?.outputFormat ?? 'png',
        output_compression: imageCfg?.outputCompression,
        // input_fidelity: imageCfg?.inputFidelity ?? 'low',
      });

      const images: Array<{ relativePath?: string; base64?: string }> = [];
      for (const [idx, item] of (response.data ?? []).entries()) {
        if (!item.b64_json) continue;
        images.push(await this.buildImageEntry(item.b64_json, `edit_${idx}`));
      }

      if (images.length === 0) {
        return {
          error: { code: 'no_image', message: 'OpenAI returned no image data' },
          images: [],
          metadata: { prompt, model },
        };
      }

      return {
        images,
        metadata: {
          prompt,
          model,
          size,
          quality,
          inputFidelity: imageCfg?.inputFidelity ?? 'low',
          usage: response.usage,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] generateImageFromImage failed:', err);
      return {
        error: { code: 'edit_failed', message: err.message },
        images: [],
        text: `图片编辑失败：${err.message}`,
        metadata: { prompt, model },
      };
    }
  }

  /**
   * Convert a string image reference (URL, raw base64, or local file path) to a Buffer.
   * Mirrors `visionImageToString`'s priority — caller already collapsed VisionImage to a string.
   */
  private async loadImageToBuffer(image: string): Promise<Buffer> {
    if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('file://')) {
      const base64 = await ResourceDownloader.downloadToBase64(image, {
        timeout: 30000,
        maxSize: 50 * 1024 * 1024,
        filename: `openai_input_${Date.now()}`,
      });
      return Buffer.from(base64, 'base64');
    }
    if (image.startsWith('data:')) {
      const commaIdx = image.indexOf(',');
      return Buffer.from(image.slice(commaIdx + 1), 'base64');
    }
    if (/^[A-Za-z0-9+/=]+$/.test(image) && image.length > 64) {
      // Raw base64 string
      return Buffer.from(image, 'base64');
    }
    // Treat as local file path
    const base64 = await ResourceDownloader.downloadToBase64(image, {
      timeout: 5000,
      maxSize: 50 * 1024 * 1024,
      filename: `openai_input_${Date.now()}`,
    });
    return Buffer.from(base64, 'base64');
  }

  /**
   * Generate text with vision and streaming support
   */
  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = options?.model ?? this.config.model ?? 'gpt-4-vision-preview';
    const temperature = options?.temperature ?? this.config.defaultTemperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 2000;

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating stream with vision, model: ${model}`);

      // Build content array with text and images
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: prompt },
      ];

      // Add images to content
      for (const image of images) {
        let imageUrl: string;
        if (image.url) {
          imageUrl = image.url;
        } else if (image.base64) {
          const mimeType = image.mimeType || 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${image.base64}`;
        } else if (image.file) {
          throw new Error('File path images not directly supported. Please use URL or base64.');
        } else {
          throw new Error('Invalid image format. Must provide url, base64, or file.');
        }

        content.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }

      const messages: Array<
        | { role: 'system'; content: string }
        | {
            role: 'user';
            content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
          }
      > = [];
      if (options?.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }
      messages.push({
        role: 'user',
        content,
      });

      const stream = await this.client.chat.completions.create({
        model,
        messages,
        temperature,
        max_completion_tokens: maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stop,
        stream: true,
      });

      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          handler(content);
        }

        // Capture usage if available
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }

      return {
        text: fullText,
        usage,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Vision stream generation failed:', err);
      throw err;
    }
  }
}
