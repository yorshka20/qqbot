// Laozhang AI Provider implementation

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpClient } from '@/api/http/HttpClient';
import type { LaozhangProviderConfig } from '@/core/config/types/ai';
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
import type { AIGenerateOptions, AIGenerateResponse, StreamingHandler } from '../types';
import {
  handleFinishReason,
  handleGeneralError,
  handleInvalidContent,
  handleNoCandidates,
  handleNoImageData,
} from '../utils/geminiErrorHandler';
import { ResourceDownloader } from '../utils/ResourceDownloader';

/**
 * Laozhang/Gemini API response types
 */
interface LaozhangApiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
}

type LaoZhangRatioKey = (typeof LaozhangProvider.SUPPORTED_ASPECT_RATIOS)[number];
type LaoZhangImageSizeKey = (typeof LaozhangProvider.SUPPORTED_IMAGE_SIZES)[number];

/**
 * Laozhang AI Provider implementation
 * LLM, vision, text2img and img2img via Laozhang AI API (Gemini API forwarder).
 * Capabilities are enabled by config: llm, vision, text2img each optional and independent.
 */
export class LaozhangProvider
  extends AIProvider
  implements Text2ImageCapability, Image2ImageCapability, LLMCapability, VisionCapability
{
  readonly name = 'laozhang';
  override readonly isRelay = true;
  private config: LaozhangProviderConfig;
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  private outputPath = join(getRepoRoot(), 'output', 'laozhang');

  // Default values
  private static readonly DEFAULT_MODEL = 'gemini-3-pro-image-preview';
  private static readonly DEFAULT_BASE_URL = 'https://api.laozhang.ai';
  private static readonly DEFAULT_ASPECT_RATIO = '16:9';
  private static readonly DEFAULT_IMAGE_SIZE = '2K';
  private static readonly TIMEOUT = 10 * 60 * 1000; // 10 minutes for image generation
  private static readonly LLM_TIMEOUT = 60 * 1000; // 1 minute for LLM/vision

  // Supported aspect ratios
  static readonly SUPPORTED_ASPECT_RATIOS = [
    '1:1',
    '16:9',
    '9:16',
    '4:3',
    '3:4',
    '21:9',
    '3:2',
    '2:3',
    '5:4',
    '4:5',
  ] as const;

  // Supported image sizes
  static readonly SUPPORTED_IMAGE_SIZES = ['1K', '2K', '4K'] as const;

  constructor(config: LaozhangProviderConfig) {
    super();
    this.config = config;

    // Build capabilities from structured config: llm, vision, text2img(+img2img)
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

    // Configure HttpClient
    this.httpClient = new HttpClient({
      baseURL: this.config.baseURL ?? LaozhangProvider.DEFAULT_BASE_URL,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      defaultTimeout: LaozhangProvider.TIMEOUT,
    });

    logger.info('[LaozhangProvider] Initialized');
  }

  /** Text2img model from config.text2img */
  private getText2ImgModel(): string {
    return this.config.text2img?.model ?? LaozhangProvider.DEFAULT_MODEL;
  }

  /** Default aspect ratio from config.text2img */
  private getDefaultAspectRatio(): string {
    return this.config.text2img?.defaultAspectRatio ?? LaozhangProvider.DEFAULT_ASPECT_RATIO;
  }

  /** Default image size from config.text2img */
  private getDefaultImageSize(): string {
    return this.config.text2img?.defaultImageSize ?? LaozhangProvider.DEFAULT_IMAGE_SIZE;
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    return true;
  }

  getConfig(): Record<string, unknown> {
    return {
      baseURL: this.config.baseURL ?? LaozhangProvider.DEFAULT_BASE_URL,
      llm: this.config.llm ?? undefined,
      vision: this.config.vision ?? undefined,
      text2img: this.config.text2img ?? undefined,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Validate aspect ratio
   */
  private validateAspectRatio(ratio: string): boolean {
    return LaozhangProvider.SUPPORTED_ASPECT_RATIOS.includes(ratio as LaoZhangRatioKey);
  }

  /**
   * Validate image size (case-insensitive)
   */
  private validateImageSize(size: string): boolean {
    const normalizedSize = size.toUpperCase();
    return LaozhangProvider.SUPPORTED_IMAGE_SIZES.includes(normalizedSize as LaoZhangImageSizeKey);
  }

  /**
   * Normalize image size to uppercase (e.g., "4k" -> "4K")
   */
  private normalizeImageSize(size: string): string {
    return size.toUpperCase();
  }

  /**
   * Resolve aspect ratio from options or config
   */
  private resolveAspectRatio(options?: Text2ImageOptions): string {
    // Priority 1: options.aspectRatio
    if (options?.aspectRatio && this.validateAspectRatio(options.aspectRatio as string)) {
      return options.aspectRatio as string;
    }

    // Priority 2: config default aspect ratio
    const defaultRatio = this.getDefaultAspectRatio();
    if (defaultRatio && this.validateAspectRatio(defaultRatio)) {
      return defaultRatio;
    }

    // Fallback
    return LaozhangProvider.DEFAULT_ASPECT_RATIO;
  }

  /**
   * Resolve image size from options or config
   * Ensures the returned value always has uppercase K (e.g., "4K" not "4k")
   */
  private resolveImageSize(options?: Text2ImageOptions | Image2ImageOptions): string {
    // Priority 1: options.imageSize
    if (options?.imageSize && this.validateImageSize(options.imageSize as string)) {
      return this.normalizeImageSize(options.imageSize as string);
    }

    // Priority 2: config default image size
    const defaultSize = this.getDefaultImageSize();
    if (defaultSize && this.validateImageSize(defaultSize)) {
      return this.normalizeImageSize(defaultSize);
    }

    // Fallback (already uppercase)
    return LaozhangProvider.DEFAULT_IMAGE_SIZE;
  }

  /**
   * Resolve aspect ratio from options or config (for Image2Image)
   */
  private resolveAspectRatioForImage2Image(options?: Image2ImageOptions): string {
    // Priority 1: options.aspectRatio
    if (options?.aspectRatio && this.validateAspectRatio(options.aspectRatio as string)) {
      return options.aspectRatio as string;
    }

    // Priority 2: config default aspect ratio
    const defaultRatio = this.getDefaultAspectRatio();
    if (defaultRatio && this.validateAspectRatio(defaultRatio)) {
      return defaultRatio;
    }

    // Fallback
    return LaozhangProvider.DEFAULT_ASPECT_RATIO;
  }

  /**
   * Sanitize response object for logging by removing/truncating large base64 data and long strings
   */
  private sanitizeResponseForLogging(response: unknown): unknown {
    if (!response || typeof response !== 'object') {
      return response;
    }

    try {
      // Deep clone to avoid mutating original
      const sanitized = JSON.parse(JSON.stringify(response));

      // Recursively find and truncate large strings (base64 data, thoughtSignature, etc.)
      const sanitizeObject = (obj: unknown): unknown => {
        if (!obj || typeof obj !== 'object') {
          return obj;
        }

        if (Array.isArray(obj)) {
          return obj.map((item) => sanitizeObject(item));
        }

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          // Truncate any long string fields (base64 data, signatures, etc.)
          if (typeof value === 'string' && value.length > 200) {
            // Truncate long strings (base64 data, thoughtSignature, etc.)
            result[key] = `${value.substring(0, 50)}... [${value.length} chars truncated]`;
          } else if (key === 'inlineData' && value && typeof value === 'object' && 'data' in value) {
            // Handle inlineData.data specifically
            const dataValue = (value as Record<string, unknown>).data;
            if (typeof dataValue === 'string' && dataValue.length > 100) {
              result[key] = {
                ...(value as object),
                data: `${dataValue.substring(0, 50)}... [${dataValue.length} chars truncated]`,
              };
            } else {
              result[key] = sanitizeObject(value);
            }
          } else {
            result[key] = sanitizeObject(value);
          }
        }
        return result;
      };

      return sanitizeObject(sanitized);
    } catch (error) {
      logger.error(
        `[LaozhangProvider] Failed to sanitize response for logging: ${error instanceof Error ? error.message : String(error)}`,
      );
      // If JSON parsing fails, return a simple representation
      return { ...(response as Record<string, unknown>), _error: 'Failed to sanitize response for logging' };
    }
  }

  /**
   * Convert VisionImage[] to Gemini inlineData parts for vision requests
   */
  private async visionImagesToInlineParts(
    images: VisionImage[],
  ): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
    const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
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
        filename: `laozhang_image_${Date.now()}.png`,
      });
      parts.push({ inlineData: { mimeType, data } });
    }
    return parts;
  }

  /**
   * Call Gemini generateContent for text response (LLM or vision). Returns combined text from parts.
   */
  private async generateContentText(
    model: string,
    contentsParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<{ text: string; usage?: AIGenerateResponse['usage'] }> {
    const endpoint = `/v1beta/models/${model}:generateContent`;
    const payload = {
      contents: [{ parts: contentsParts }],
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 2000,
      },
    };
    const response = await this.httpClient.post<LaozhangApiResponse>(endpoint, payload, {
      timeout: LaozhangProvider.LLM_TIMEOUT,
    });
    const noCandidatesError = handleNoCandidates(response, '');
    if (noCandidatesError) {
      throw new Error(noCandidatesError.text || 'No candidates in response');
    }
    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error('Invalid response structure');
    }
    const text = candidate.content.parts.map((p) => p.text ?? '').join('');
    return {
      text,
      usage: undefined, // Laozhang/Gemini may not return token usage in same shape
    };
  }

  async generate(prompt: string, options?: AIGenerateOptions): Promise<AIGenerateResponse> {
    if (!this.config.llm) {
      throw new Error('LaozhangProvider: llm not configured');
    }
    const model = options?.model ?? this.config.llm.model;
    const temperature = options?.temperature ?? this.config.llm.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.llm.maxTokens ?? 2000;
    const contentsParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (options?.messages?.length) {
      for (const msg of options.messages) {
        if (typeof msg.content === 'string') {
          contentsParts.push({ text: `${msg.role}: ${msg.content}\n\n` });
        } else if (Array.isArray(msg.content)) {
          contentsParts.push({ text: `${msg.role}: ` });
          for (const part of msg.content) {
            if (part.type === 'text') {
              if (part.text) contentsParts.push({ text: part.text });
            } else if (part.type === 'image_url') {
              const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
              if (dataUrlMatch) {
                contentsParts.push({ inlineData: { mimeType: dataUrlMatch[1], data: dataUrlMatch[2] } });
              }
            }
          }
          contentsParts.push({ text: '\n\n' });
        }
      }
    } else {
      const history = await this.loadHistory(options);
      if (options?.systemPrompt) {
        contentsParts.push({ text: `system: ${options.systemPrompt}\n\n` });
      }
      for (const msg of history) {
        contentsParts.push({ text: `${msg.role}: ${msg.content}\n\n` });
      }
      contentsParts.push({ text: prompt });
    }
    const { text, usage } = await this.generateContentText(model, contentsParts, {
      temperature,
      maxTokens,
    });
    return { text, usage };
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

  async generateWithVision(
    prompt: string,
    images: VisionImage[],
    options?: AIGenerateOptions,
  ): Promise<AIGenerateResponse> {
    if (!this.config.vision) {
      throw new Error('LaozhangProvider: vision not configured');
    }
    const model = this.config.vision.model;
    const imageParts = await this.visionImagesToInlineParts(images);
    const systemPrompt = [];
    if (options?.systemPrompt) {
      systemPrompt.push({ text: `system: ${options.systemPrompt}\n\n` });
    }
    const contentsParts = [...systemPrompt, { text: prompt }, ...imageParts];
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

  /**
   * Save image data to local file
   * Supports both Buffer and base64 string input
   * @returns Relative path from output directory (e.g., 'laozhang/image.png') or null if save failed
   */
  private async saveImageToFile(imageData: Buffer | string, originalFilename: string): Promise<string | null> {
    try {
      const outputDir = this.outputPath;
      await mkdir(outputDir, { recursive: true });

      // Generate filename using timestamp and original filename
      const timestamp = Date.now();
      const filename = `${timestamp}_${originalFilename}`;
      const filepath = join(outputDir, filename);

      // Convert to buffer if needed
      let imageBuffer: Buffer;
      if (imageData instanceof Buffer) {
        imageBuffer = imageData;
      } else if (typeof imageData === 'string') {
        imageBuffer = Buffer.from(imageData, 'base64');
      } else {
        throw new Error('Invalid imageData type');
      }
      await writeFile(filepath, imageBuffer);

      // Build relative path: providerName/filename
      const relativePath = `laozhang/${filename}`;

      logger.info(`[LaozhangProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return relativePath;
    } catch (error) {
      logger.warn(
        `[LaozhangProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('LaozhangProvider is not available: apiKey not configured');
    }

    try {
      logger.info(`[LaozhangProvider] Starting image generation for prompt: ${prompt}`);

      // Support model override via options.model
      const model = options?.model || this.getText2ImgModel();
      const aspectRatio = this.resolveAspectRatio(options);
      const imageSize = this.resolveImageSize(options);

      logger.info(`[LaozhangProvider] Parameters: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}`);

      // Build API endpoint
      const endpoint = `/v1beta/models/${model}:generateContent`;

      // Build request payload
      // Format matches Python reference: contents[0].parts[0].text = prompt
      const payload = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio,
            imageSize,
          },
        },
      };

      // Log request details for debugging (complete payload for verification)
      logger.debug(`[LaozhangProvider] Request payload: ${JSON.stringify(payload, null, 2)}`);

      // Make HTTP request
      const response = await this.httpClient.post<LaozhangApiResponse>(endpoint, payload, {
        timeout: LaozhangProvider.TIMEOUT,
      });

      logger.debug(`[LaozhangProvider] Response received`, this.sanitizeResponseForLogging(response));

      // Response structure: candidates[0].content.parts[] with inlineData
      // Check for no candidates error
      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      // At this point, response.candidates is guaranteed to exist and have at least one element
      const candidate = response.candidates?.[0];
      if (!candidate) {
        return {
          images: [],
          text: '',
          metadata: {
            prompt,
            numImages: 0,
          },
          error: {
            code: 'no_candidates',
            message: 'No candidates in response',
          },
        };
      }

      // Check finish reason for errors
      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      // Check for invalid content structure
      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      // At this point, candidate.content and candidate.content.parts are guaranteed to exist
      const parts = candidate.content?.parts ?? [];

      // Find image part in response
      let imageData: string | null = null;
      let text: string = '';
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
        // No image data found - check if there's a text explanation
        return handleNoImageData(text, prompt);
      }

      logger.info(`[LaozhangProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      // Determine file extension from mime type
      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `laozhang_image${extension}`;

      // Save image to local file
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      // Build response
      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        // Fallback to base64 if file save failed
        imageDataResponse.base64 = imageData;
        logger.warn('[LaozhangProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          aspectRatio,
          imageSize,
          model,
          mimeType,
        },
      };
    } catch (error) {
      // Return error message in text field instead of throwing
      return handleGeneralError(error, prompt);
    }
  }

  /**
   * Generate image from image based on prompt (image-to-image generation)
   * Supports single image input
   */
  async generateImageFromImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('LaozhangProvider is not available: apiKey not configured');
    }

    try {
      logger.info(`[LaozhangProvider] Starting image-to-image transformation for prompt: ${prompt}`);

      const model = this.getText2ImgModel();
      const aspectRatio = this.resolveAspectRatioForImage2Image(options);
      const imageSize = this.resolveImageSize(options);

      logger.info(`[LaozhangProvider] Parameters: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}`);

      // Load input image and convert to base64 (reuse shared util)
      const { data: imageBase64, mimeType: imageMimeType } = await ResourceDownloader.downloadImageToBase64WithMimeType(
        image,
        {
          timeout: 30000,
          maxSize: 10 * 1024 * 1024,
          filename: `laozhang_image_${Date.now()}.png`,
        },
      );

      // Build API endpoint
      const endpoint = `/v1beta/models/${model}:generateContent`;

      // Build request payload for image-to-image
      // Format: contents[0].parts contains both text and inline_data
      const payload = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
              {
                inlineData: {
                  mimeType: imageMimeType,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio,
            imageSize,
          },
        },
      };

      // Log request payload for debugging (using sanitizeResponseForLogging to truncate base64 data)
      logger.debug(
        `[LaozhangProvider] Request payload: ${JSON.stringify(this.sanitizeResponseForLogging(payload), null, 2)}`,
      );

      // Make HTTP request
      const response = await this.httpClient.post<LaozhangApiResponse>(endpoint, payload, {
        timeout: LaozhangProvider.TIMEOUT,
      });

      logger.debug(`[LaozhangProvider] Response received`, this.sanitizeResponseForLogging(response));

      // Response structure: candidates[0].content.parts[] with inlineData
      // Check for no candidates error
      const noCandidatesError = handleNoCandidates(response, prompt);
      if (noCandidatesError) {
        return noCandidatesError;
      }

      // At this point, response.candidates is guaranteed to exist and have at least one element
      const candidate = response.candidates?.[0];
      if (!candidate) {
        return {
          images: [],
          text: '',
          metadata: {
            prompt,
            numImages: 0,
          },
          error: {
            code: 'no_candidates',
            message: 'No candidates in response',
          },
        };
      }

      // Check finish reason for errors
      const finishReasonError = handleFinishReason(candidate, prompt);
      if (finishReasonError) {
        return finishReasonError;
      }

      // Check for invalid content structure
      const invalidContentError = handleInvalidContent(candidate, prompt);
      if (invalidContentError) {
        return invalidContentError;
      }

      // At this point, candidate.content and candidate.content.parts are guaranteed to exist
      const parts = candidate.content?.parts ?? [];

      // Find image part in response
      let imageData: string | null = null;
      let text: string = '';
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
        // No image data found - check if there's a text explanation
        return handleNoImageData(text, prompt);
      }

      logger.info(`[LaozhangProvider] Extracted image data (${imageData.length} chars, mimeType: ${mimeType})`);

      // Determine file extension from mime type
      const extension = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : '.png';
      const originalFilename = `laozhang_img2img${extension}`;

      // Save image to local file
      const relativePath = await this.saveImageToFile(imageData, originalFilename);

      // Build response
      const imageDataResponse: { relativePath?: string; base64?: string } = {};
      if (relativePath) {
        imageDataResponse.relativePath = relativePath;
      } else {
        // Fallback to base64 if file save failed
        imageDataResponse.base64 = imageData;
        logger.warn('[LaozhangProvider] File save failed, using base64 fallback');
      }

      return {
        images: [imageDataResponse],
        text,
        metadata: {
          prompt,
          numImages: 1,
          aspectRatio,
          imageSize,
          model,
          mimeType,
          inputImage: image.substring(0, 100), // Store first 100 chars of input image identifier
        },
      };
    } catch (error) {
      // Return error message in text field instead of throwing
      return handleGeneralError(error, prompt);
    }
  }
}
