// Gemini Provider implementation

import { GoogleGenAI } from '@google/genai';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { GeminiProviderConfig } from '@/core/config/types/ai';
import { logger } from '@/utils/logger';
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
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler, ToolDefinition } from '../types';
import { contentToPlainString } from '../utils/contentUtils';
import {
  handleFinishReason,
  handleGeneralError,
  handleInvalidContent,
  handleNoCandidates,
  handleNoImageData,
} from '../utils/geminiErrorHandler';
import { ResourceDownloader } from '../utils/ResourceDownloader';

/** Runtime key mode for Gemini (free vs paid tier). Switch via GeminiProvider.setKeyMode(). */
export type GeminiKeyMode = 'free' | 'paid';

/**
 * Gemini Provider implementation
 * LLM, vision, text2img and img2img via Google Gemini API.
 * Capabilities are enabled by config: llm, vision, text2img each optional and independent.
 * Supports free/paid key modes: set apiKeyFree and apiKeyPaid, then switch at runtime via GeminiProvider.setKeyMode().
 */
export class GeminiProvider
  extends AIProvider
  implements Text2ImageCapability, Image2ImageCapability, LLMCapability, VisionCapability
{
  readonly name = 'gemini';
  private config: GeminiProviderConfig;
  private _capabilities: CapabilityType[];
  /** Cached clients per key so we use the key for current mode; model unchanged. */
  private clientFree: GoogleGenAI | null = null;
  private clientPaid: GoogleGenAI | null = null;

  private outputPath = join(process.cwd(), 'output', 'gemini');

  // Default values for text2img when not overridden by config
  private static readonly DEFAULT_T2I_MODEL = 'gemini-2.5-flash-image';
  private static readonly DEFAULT_WIDTH = 1024;
  private static readonly DEFAULT_HEIGHT = 1024;

  /** Runtime key mode (free/paid). Default 'free'. Switch via GeminiProvider.setKeyMode(). */
  private static _keyMode: GeminiKeyMode = 'free';
  static getKeyMode(): GeminiKeyMode {
    return GeminiProvider._keyMode;
  }
  static setKeyMode(mode: GeminiKeyMode): void {
    GeminiProvider._keyMode = mode;
  }

  constructor(config: GeminiProviderConfig) {
    super();
    this.config = config;

    // Build capabilities from structured config: llm, vision, text2img (+ img2img)
    this._capabilities = [];
    if (config.llm) {
      this._capabilities.push('llm');
      this.setContextConfig(config.llm.enableContext ?? false, config.llm.contextMessageCount ?? 10);
    }
    if (config.vision) {
      this._capabilities.push('vision');
    }
    if (config.text2img) {
      this._capabilities.push('text2img', 'img2img');
    }

    // Clients are created lazily in getClient() using the key for current mode
    logger.info('[GeminiProvider] Initialized (free/paid key mode supported)');
  }

  /** Resolve API key for current runtime mode (free or paid). Model is unchanged. */
  private getEffectiveApiKey(): string | undefined {
    const mode = GeminiProvider.getKeyMode();
    return mode === 'free' ? this.config.apiKeyFree : this.config.apiKeyPaid;
  }

  /** Return GoogleGenAI client for current key mode; creates and caches per key. */
  private getClient(): GoogleGenAI {
    const mode = GeminiProvider.getKeyMode();
    if (mode === 'free') {
      if (!this.clientFree) {
        this.clientFree = new GoogleGenAI({ apiKey: this.config.apiKeyFree });
      }
      return this.clientFree;
    }
    if (!this.clientPaid) {
      this.clientPaid = new GoogleGenAI({ apiKey: this.config.apiKeyPaid });
    }
    return this.clientPaid;
  }

  /** Text2img/img2img model from config.text2img */
  private getText2ImgModel(): string {
    return this.config.text2img?.model ?? GeminiProvider.DEFAULT_T2I_MODEL;
  }

  /** Default width from config.text2img */
  private getDefaultWidth(): number {
    return this.config.text2img?.defaultWidth ?? GeminiProvider.DEFAULT_WIDTH;
  }

  /** Default height from config.text2img */
  private getDefaultHeight(): number {
    return this.config.text2img?.defaultHeight ?? GeminiProvider.DEFAULT_HEIGHT;
  }

  isAvailable(): boolean {
    return !!this.getEffectiveApiKey();
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    try {
      const client = this.getClient();
      const model = this.config.llm?.model ?? this.config.vision?.model ?? 'gemini-2.5-flash';
      await client.models.get({ model });
      return true;
    } catch (error) {
      logger.debug('[GeminiProvider] Availability check failed:', error);
      if (error instanceof Error && error.message.includes('timeout')) {
        return false;
      }
      // Non-timeout errors (401, 400) mean API is reachable
      return true;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      llm: this.config.llm ?? undefined,
      vision: this.config.vision ?? undefined,
      text2img: this.config.text2img ?? undefined,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Save image data to local file
   * Supports both Buffer and base64 string input
   * @returns Relative path from output directory (e.g., 'gemini/image.png') or null if save failed
   */
  private async saveImageToFile(imageData: Buffer | string, originalFilename: string): Promise<string | null> {
    try {
      const outputDir = this.outputPath;
      await mkdir(outputDir, { recursive: true });

      const timestamp = Date.now();
      const filename = `${timestamp}_${originalFilename}`;
      const filepath = join(outputDir, filename);

      let imageBuffer: Buffer;
      if (imageData instanceof Buffer) {
        imageBuffer = imageData;
      } else if (typeof imageData === 'string') {
        imageBuffer = Buffer.from(imageData, 'base64');
      } else {
        throw new Error('Invalid imageData type');
      }
      await writeFile(filepath, imageBuffer);

      const relativePath = `gemini/${filename}`;
      logger.info(`[GeminiProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return relativePath;
    } catch (error) {
      logger.warn(
        `[GeminiProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Map ToolDefinition[] to Gemini API tools format (functionDeclarations).
   */
  private static mapToolsToGemini(tools: ToolDefinition[]): Array<{
    functionDeclarations: Array<{
      name?: string;
      description?: string;
      parameters?: unknown;
      parametersJsonSchema?: unknown;
    }>;
  }> {
    if (!tools.length) {
      return [];
    }
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }));
    return [{ functionDeclarations }];
  }

  /**
   * Call generateContent for text response (LLM or vision). Optional tools for function calling.
   * Returns text, usage, and if the model chose to call a function: functionCall + toolCallId.
   */
  private async generateContentText(
    model: string,
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: ToolDefinition[];
    },
  ): Promise<{
    text: string;
    usage?: AIGenerateResponse['usage'];
    functionCall?: AIGenerateResponse['functionCall'];
    toolCallId?: string;
  }> {
    const config: Record<string, unknown> = {
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens ?? 2000,
    };
    if (options?.tools?.length) {
      config.tools = GeminiProvider.mapToolsToGemini(options.tools);
      config.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const response = await this.getClient().models.generateContent({
      model,
      contents: parts,
      config,
    });

    const noCandidatesError = handleNoCandidates(response, '');
    if (noCandidatesError) {
      throw new Error(noCandidatesError.text || 'No candidates in response');
    }

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('Invalid response structure');
    }

    const text = (response as { text?: string }).text ?? candidate.content.parts.map((p) => p.text ?? '').join('');
    const out: {
      text: string;
      usage?: AIGenerateResponse['usage'];
      functionCall?: AIGenerateResponse['functionCall'];
      toolCallId?: string;
    } = {
      text: text ?? '',
      usage: undefined,
    };

    const functionCalls = (
      response as { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> }
    ).functionCalls;
    if (functionCalls?.length) {
      const fc = functionCalls[0];
      if (fc?.name) {
        let argsStr: string;
        if (typeof fc.args === 'object' && fc.args !== null) {
          argsStr = JSON.stringify(fc.args);
        } else if (typeof fc.args === 'string') {
          argsStr = fc.args;
        } else {
          argsStr = '{}';
        }
        out.functionCall = { name: fc.name, arguments: argsStr };
        out.toolCallId = fc.id;
      }
    }

    return out;
  }

  /**
   * Convert VisionImage[] to inlineData parts for vision requests
   */
  private async visionImagesToInlineParts(
    images: VisionImage[],
  ): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
    const result: Array<{ inlineData: { mimeType: string; data: string } }> = [];
    for (const img of images) {
      let resource: string;
      if (img.base64) {
        resource = `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`;
      } else if (img.file) {
        resource = img.file.startsWith('file://') ? img.file : img.file;
      } else if (img.url) {
        resource = img.url;
      } else {
        continue;
      }
      const { data, mimeType } = await ResourceDownloader.downloadImageToBase64WithMimeType(resource, {
        timeout: 30000,
        maxSize: 10 * 1024 * 1024,
        filename: `gemini_image_${Date.now()}.png`,
      });
      result.push({ inlineData: { mimeType, data } });
    }
    return result;
  }

  // ---------- LLMCapability ----------

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.config.llm) {
      throw new Error('GeminiProvider: llm not configured');
    }
    const model = options?.model ?? this.config.llm.model;
    const temperature = options?.temperature ?? this.config.llm.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.llm.maxTokens ?? 2000;

    const parts: Array<{ text: string }> = [];
    if (options?.messages?.length) {
      for (const msg of options.messages) {
        parts.push({ text: `${msg.role}: ${contentToPlainString(msg.content)}\n\n` });
      }
    } else {
      const history = await this.loadHistory(options);
      if (options?.systemPrompt) {
        parts.push({ text: `system: ${options.systemPrompt}\n\n` });
      }
      for (const msg of history) {
        parts.push({ text: `${msg.role}: ${msg.content}\n\n` });
      }
    }
    parts.push({ text: prompt });
    const fullPrompt = parts.map((p) => p.text).join('');

    const result = await this.generateContentText(model, [{ text: fullPrompt }], {
      temperature,
      maxTokens,
      tools: options?.tools,
    });
    return {
      text: result.text,
      usage: result.usage,
      functionCall: result.functionCall,
      toolCallId: result.toolCallId,
    };
  }

  async generateStream(
    prompt: string,
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const result = await this.generate(prompt, options);
    handler(result.text);
    return result;
  }

  // ---------- VisionCapability ----------

  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.config.vision) {
      throw new Error('GeminiProvider: vision not configured');
    }
    const model = this.config.vision.model;
    const imageParts = await this.visionImagesToInlineParts(images);
    const contentsParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (options?.systemPrompt) {
      contentsParts.push({ text: `system: ${options.systemPrompt}\n\n` });
    }
    contentsParts.push({ text: prompt });
    contentsParts.push(...imageParts);

    return this.generateContentText(model, contentsParts, {
      temperature: options?.temperature ?? 0.7,
      maxTokens: options?.maxTokens ?? 2000,
    });
  }

  async generateStreamWithVision(
    prompt: string,
    images: VisionImage[],
    handler: StreamingHandler,
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    const result = await this.generateWithVision(prompt, images, options);
    handler(result.text);
    return result;
  }

  async explainImages(images: VisionImage[], prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    return this.generateWithVision(prompt, images, options);
  }

  // ---------- Text2ImageCapability ----------

  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('GeminiProvider is not available: apiKeyFree/apiKeyPaid not configured');
    }
    if (!this.config.text2img) {
      throw new Error('GeminiProvider: text2img not configured');
    }

    try {
      logger.info(`[GeminiProvider] Starting image generation for prompt: ${prompt}`);

      const model = options?.model ?? this.getText2ImgModel();
      const width = options?.width ?? this.getDefaultWidth();
      const height = options?.height ?? this.getDefaultHeight();

      logger.info(`[GeminiProvider] Parameters: model=${model}, size=${width}x${height}`);

      const response = await this.getClient().models.generateContent({
        model,
        contents: prompt,
      });

      logger.debug(`[GeminiProvider] Response received`, response);

      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      const candidate = response.candidates?.[0];
      if (!candidate) {
        return {
          images: [],
          text: '',
          metadata: { prompt, numImages: 0 },
          error: { code: 'no_candidates', message: 'No candidates in response' },
        };
      }
      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      const parts = candidate.content?.parts ?? [];
      let imageData: string | null = null;
      let text = '';
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.text) {
          text = part.text;
        } else if (part.inlineData) {
          const data = part.inlineData.data;
          if (data) {
            imageData = data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }
      }

      if (!imageData) {
        return handleNoImageData(text, prompt);
      }

      logger.info(`[GeminiProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `gemini_image${extension}`;
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        imageDataResponse.base64 = imageData;
        logger.warn('[GeminiProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          width,
          height,
          model,
          mimeType,
        },
      };
    } catch (error) {
      return handleGeneralError(error, prompt);
    }
  }

  // ---------- Image2ImageCapability ----------

  async generateImageFromImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('GeminiProvider is not available: apiKeyFree/apiKeyPaid not configured');
    }
    if (!this.config.text2img) {
      throw new Error('GeminiProvider: text2img not configured (required for img2img)');
    }

    try {
      logger.info(`[GeminiProvider] Starting image-to-image transformation for prompt: ${prompt}`);

      const model = options?.model ?? this.getText2ImgModel();
      const width = options?.width ?? this.getDefaultWidth();
      const height = options?.height ?? this.getDefaultHeight();

      const { data: imageBase64, mimeType: imageMimeType } = await ResourceDownloader.downloadImageToBase64WithMimeType(
        image,
        {
          timeout: 30000,
          maxSize: 10 * 1024 * 1024,
          filename: `gemini_image_${Date.now()}.png`,
        },
      );

      const response = await this.getClient().models.generateContent({
        model,
        contents: [{ text: prompt }, { inlineData: { mimeType: imageMimeType, data: imageBase64 } }],
      });

      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      const candidate = response.candidates?.[0];
      if (!candidate) {
        return {
          images: [],
          text: '',
          metadata: { prompt, numImages: 0 },
          error: { code: 'no_candidates', message: 'No candidates in response' },
        };
      }

      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      const parts = candidate.content?.parts ?? [];
      let imageData: string | null = null;
      let text = '';
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.text) {
          text = part.text;
        } else if (part.inlineData) {
          const data = part.inlineData.data;
          if (data) {
            imageData = data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }
      }

      if (!imageData) {
        return handleNoImageData(text, prompt);
      }

      logger.info(`[GeminiProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `gemini_img2img${extension}`;
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        imageDataResponse.base64 = imageData;
        logger.warn('[GeminiProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          width,
          height,
          model,
          mimeType,
          inputImage: image.substring(0, 100),
        },
      };
    } catch (error) {
      return handleGeneralError(error, prompt);
    }
  }
}
