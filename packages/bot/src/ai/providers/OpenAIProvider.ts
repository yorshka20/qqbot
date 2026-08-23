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
  ChatMessage,
  ContentPart,
  StreamingHandler,
  ToolDefinition,
} from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import { ResourceDownloader } from '../utils/ResourceDownloader';

/**
 * Translate the pipeline's reasoning effort into the Responses API `reasoning` param.
 * `'minimal'` is not an accepted value (only none/low/medium/high/xhigh), so it
 * clamps up to `'low'` — the smallest valid effort, preserving the latency intent.
 *
 * When reasoning is on, `summary: 'auto'` asks the API to return reasoning-summary
 * items in the output, which parseResponsesOutput normalizes into reasoningContent
 * (the raw chain of thought is never returned by the Responses API).
 */
function mapReasoningEffortToOpenAI(
  effort: AIGenerateOptions['reasoningEffort'],
): OpenAI.Responses.ResponseCreateParams['reasoning'] {
  if (!effort) {
    return undefined;
  }
  if (effort === 'none') {
    return { effort: 'none' };
  }
  return { effort: effort === 'minimal' ? 'low' : effort, summary: 'auto' };
}

/** Map a ChatMessage's content to Responses input content (text + image parts). */
function mapContentToResponsesInput(content: ChatMessage['content']): OpenAI.Responses.ResponseInputMessageContentList {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  const parts: OpenAI.Responses.ResponseInputMessageContentList = [];
  for (const part of content ?? []) {
    if (part.type === 'text') {
      parts.push({ type: 'input_text', text: part.text });
    } else if (part.type === 'image_url') {
      parts.push({ type: 'input_image', image_url: part.image_url.url, detail: 'auto' });
    }
  }
  return parts;
}

/**
 * Map ChatMessage[] to Responses API input items.
 *
 * The Responses API flattens tool use into standalone items rather than nesting it
 * on the assistant message: an assistant turn's tool calls become `function_call`
 * items and each result becomes a `function_call_output` item keyed by `call_id`.
 * A tool result whose id is unknown is dropped — the API rejects a
 * `function_call_output` with no matching `function_call` in the same input.
 */
function mapMessagesToResponsesInput(messages: ChatMessage[]): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!m.tool_call_id) {
        continue;
      }
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }

    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : contentToPlainString(m.content ?? '');
      if (text) {
        input.push({ role: 'assistant', content: text });
      }
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      continue;
    }

    input.push({ role: m.role === 'system' ? 'system' : 'user', content: mapContentToResponsesInput(m.content) });
  }
  return input;
}

/** Map ToolDefinition[] to Responses API function tools (flat, unlike chat/completions). */
function mapToolsToResponses(tools: ToolDefinition[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: (t.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    strict: false,
  }));
}

/** Extract text, tool calls, reasoning summaries, and usage from a Responses API result. */
function parseResponsesOutput(response: OpenAI.Responses.Response): {
  text: string;
  functionCalls?: AIGenerateResponse['functionCalls'];
  usage?: AIGenerateResponse['usage'];
  reasoningContent?: string;
} {
  let text = '';
  const functionCalls: NonNullable<AIGenerateResponse['functionCalls']> = [];
  const reasoningParts: string[] = [];

  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') {
          text += part.text;
        }
      }
    } else if (item.type === 'function_call') {
      functionCalls.push({ name: item.name, arguments: item.arguments, toolCallId: item.call_id });
    } else if (item.type === 'reasoning') {
      // Hosted models return summaries (requested via reasoning.summary); `content`
      // carries raw reasoning_text only on models that expose it — take whichever exists.
      const parts = item.summary?.length ? item.summary.map((s) => s.text) : (item.content ?? []).map((c) => c.text);
      const chunk = parts.join('\n').trim();
      if (chunk) {
        reasoningParts.push(chunk);
      }
    }
  }

  const usage = response.usage
    ? {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return {
    text,
    usage,
    reasoningContent: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : undefined,
    ...(functionCalls.length > 0 ? { functionCalls } : {}),
  };
}

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
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
   * Assemble the Responses API input for a request, from either an explicit
   * `options.messages` array or the legacy history + prompt path.
   */
  private async buildResponsesInput(
    prompt: string,
    options: AIGenerateOptions | undefined,
  ): Promise<OpenAI.Responses.ResponseInput> {
    if (options?.messages?.length) {
      return mapMessagesToResponsesInput(OpenAIProvider.withSystemPrompt(options.messages, options.systemPrompt));
    }
    const history = await this.loadHistory(options);
    const messages: ChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push(...history);
    messages.push({ role: 'user', content: prompt });
    return mapMessagesToResponsesInput(messages);
  }

  /**
   * Build a Responses API request. Sampling parameters (temperature, top_p,
   * frequency/presence penalties) are deliberately not sent: the gpt-5.x reasoning
   * family rejects them outright ("Unsupported parameter: 'top_p' is not supported
   * with this model"), and reasoning depth is steered by `reasoning.effort` instead.
   */
  private buildResponsesRequest(
    model: string,
    input: OpenAI.Responses.ResponseInput,
    options: AIGenerateOptions | undefined,
  ): OpenAI.Responses.ResponseCreateParamsNonStreaming {
    const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model,
      input,
      max_output_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
      store: false,
    };
    const reasoning = mapReasoningEffortToOpenAI(options?.reasoningEffort);
    if (reasoning) {
      body.reasoning = reasoning;
    }
    if (options?.jsonMode) {
      body.text = { format: { type: 'json_object' } };
    }
    if (options?.tools?.length) {
      body.tools = mapToolsToResponses(options.tools);
      body.tool_choice = 'auto';
    }
    return body;
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const model = options?.model ?? this.config.model ?? 'gpt-3.5-turbo';

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating with model: ${model}`);

      const input = await this.buildResponsesInput(prompt, options);
      const response = await this.client.responses.create(this.buildResponsesRequest(model, input, options));
      const parsed = parseResponsesOutput(response);

      return {
        text: parsed.text,
        usage: parsed.usage,
        functionCalls: parsed.functionCalls,
        reasoningContent: parsed.reasoningContent,
        metadata: {
          model: response.model,
          finishReason: response.status,
        },
      };
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

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating stream with model: ${model}`);

      const input = await this.buildResponsesInput(prompt, options);
      const stream = await this.client.responses.create({
        ...this.buildResponsesRequest(model, input, options),
        stream: true,
      });

      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;
      let reasoningContent: string | undefined;

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          fullText += event.delta;
          handler(event.delta);
        } else if (event.type === 'response.completed') {
          if (event.response.usage) {
            usage = {
              promptTokens: event.response.usage.input_tokens,
              completionTokens: event.response.usage.output_tokens,
              totalTokens: event.response.usage.total_tokens,
            };
          }
          reasoningContent = parseResponsesOutput(event.response).reasoningContent;
        }
      }

      return {
        text: fullText,
        usage,
        reasoningContent,
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
    const input = mapMessagesToResponsesInput(messages);
    const response = await this.client.responses.create(this.buildResponsesRequest(model, input, options));
    const parsed = parseResponsesOutput(response);
    return {
      text: parsed.text,
      usage: parsed.usage,
      reasoningContent: parsed.reasoningContent,
      metadata: {
        model: response.model,
        finishReason: response.status,
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

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating with vision, model: ${model}`);

      const messages = OpenAIProvider.buildVisionMessages(prompt, images, options);
      const response = await this.client.responses.create(
        this.buildResponsesRequest(model, mapMessagesToResponsesInput(messages), options),
      );
      const parsed = parseResponsesOutput(response);

      return {
        text: parsed.text,
        usage: parsed.usage,
        reasoningContent: parsed.reasoningContent,
        metadata: {
          model: response.model,
          finishReason: response.status,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Vision generation failed:', err);
      throw err;
    }
  }

  /** Build a system + user message pair carrying the prompt text and every image as a content part. */
  private static buildVisionMessages(
    prompt: string,
    images: VisionImage[],
    options: AIGenerateOptions | undefined,
  ): ChatMessage[] {
    const content: ContentPart[] = [{ type: 'text', text: prompt }];
    for (const image of images) {
      let imageUrl: string;
      if (image.url) {
        imageUrl = image.url;
      } else if (image.base64) {
        imageUrl = `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`;
      } else if (image.file) {
        throw new Error('File path images not directly supported. Please use URL or base64.');
      } else {
        throw new Error('Invalid image format. Must provide url, base64, or file.');
      }
      content.push({ type: 'image_url', image_url: { url: imageUrl } });
    }

    const messages: ChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content });
    return messages;
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
    sourceImages: string[],
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }
    if (!sourceImages.length) {
      throw new Error('OpenAIProvider.generateImageFromImage requires at least one source image');
    }
    const imageCfg = this.config.image;
    const model = options?.model ?? imageCfg?.model ?? DEFAULT_IMAGE_MODEL;
    const size = this.resolveImageSize(options);
    const quality = imageCfg?.quality ?? 'auto';

    try {
      const ext = imageCfg?.outputFormat ?? 'png';
      const mime = ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      // gpt-image models accept multiple reference images; upload each and pass them together.
      const uploads = await Promise.all(
        sourceImages.map(async (img, idx) =>
          toFile(await this.loadImageToBuffer(img), `input_${idx}.${ext}`, { type: mime }),
        ),
      );

      logger.info(
        `[OpenAIProvider] generateImageFromImage | model=${model} size=${size} quality=${quality} images=${uploads.length}`,
      );
      const response = await this.client.images.edit({
        model,
        image: uploads,
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

    try {
      logger.info(`[STATS] [OpenAIProvider] Generating stream with vision, model: ${model}`);

      const messages = OpenAIProvider.buildVisionMessages(prompt, images, options);
      const stream = await this.client.responses.create({
        ...this.buildResponsesRequest(model, mapMessagesToResponsesInput(messages), options),
        stream: true,
      });

      let fullText = '';
      let usage: AIGenerateResponse['usage'] | undefined;
      let reasoningContent: string | undefined;

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          fullText += event.delta;
          handler(event.delta);
        } else if (event.type === 'response.completed') {
          if (event.response.usage) {
            usage = {
              promptTokens: event.response.usage.input_tokens,
              completionTokens: event.response.usage.output_tokens,
              totalTokens: event.response.usage.total_tokens,
            };
          }
          reasoningContent = parseResponsesOutput(event.response).reasoningContent;
        }
      }

      return {
        text: fullText,
        usage,
        reasoningContent,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[OpenAIProvider] Vision stream generation failed:', err);
      throw err;
    }
  }
}
