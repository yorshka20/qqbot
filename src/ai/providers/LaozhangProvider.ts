// Laozhang AI Provider implementation

import { HttpClient } from '@/api/http/HttpClient';
import type { LaozhangProviderConfig } from '@/core/config/ai';
import { logger } from '@/utils/logger';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AIProvider } from '../base/AIProvider';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2ImageOptions,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';
import { ResourceDownloader } from '../utils/ResourceDownloader';
import {
  handleFinishReason,
  handleGeneralError,
  handleInvalidContent,
  handleNoCandidates,
  handleNoImageData,
} from '../utils/geminiErrorHandler';

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

/**
 * Laozhang AI Provider implementation
 * Text-to-image and image-to-image generation using Laozhang AI API (Gemini API forwarder)
 */
export class LaozhangProvider extends AIProvider implements Text2ImageCapability, Image2ImageCapability {
  readonly name = 'laozhang';
  private config: LaozhangProviderConfig;
  private _capabilities: CapabilityType[];
  private httpClient: HttpClient;

  private outputPath = join(process.cwd(), 'output', 'laozhang');

  // Default values
  private static readonly DEFAULT_MODEL = 'gemini-3-pro-image-preview';
  private static readonly DEFAULT_BASE_URL = 'https://api.laozhang.ai';
  private static readonly DEFAULT_ASPECT_RATIO = '16:9';
  private static readonly DEFAULT_IMAGE_SIZE = '2K';
  private static readonly TIMEOUT = 10 * 60 * 1000; // 10 minutes timeout for image generation

  // Supported aspect ratios
  private static readonly SUPPORTED_ASPECT_RATIOS = [
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
  private static readonly SUPPORTED_IMAGE_SIZES = ['1K', '2K', '4K'] as const;

  constructor(config: LaozhangProviderConfig) {
    super();
    this.config = {
      model: LaozhangProvider.DEFAULT_MODEL,
      baseURL: LaozhangProvider.DEFAULT_BASE_URL,
      defaultAspectRatio: LaozhangProvider.DEFAULT_ASPECT_RATIO,
      defaultImageSize: LaozhangProvider.DEFAULT_IMAGE_SIZE,
      ...config,
    };

    this._capabilities = ['text2img', 'img2img'];

    // Configure HttpClient
    this.httpClient = new HttpClient({
      baseURL: this.config.baseURL,
      defaultHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      defaultTimeout: LaozhangProvider.TIMEOUT,
    });

    logger.info('[LaozhangProvider] Initialized');
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
      model: this.config.model,
      baseURL: this.config.baseURL,
      defaultAspectRatio: this.config.defaultAspectRatio,
      defaultImageSize: this.config.defaultImageSize,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Validate aspect ratio
   */
  private validateAspectRatio(ratio: string): boolean {
    return LaozhangProvider.SUPPORTED_ASPECT_RATIOS.includes(ratio as any);
  }

  /**
   * Validate image size (case-insensitive)
   */
  private validateImageSize(size: string): boolean {
    const normalizedSize = size.toUpperCase();
    return LaozhangProvider.SUPPORTED_IMAGE_SIZES.includes(normalizedSize as any);
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

    // Priority 2: config.defaultAspectRatio
    if (this.config.defaultAspectRatio && this.validateAspectRatio(this.config.defaultAspectRatio)) {
      return this.config.defaultAspectRatio;
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

    // Priority 2: config.defaultImageSize
    if (this.config.defaultImageSize && this.validateImageSize(this.config.defaultImageSize)) {
      return this.normalizeImageSize(this.config.defaultImageSize);
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

    // Priority 2: config.defaultAspectRatio
    if (this.config.defaultAspectRatio && this.validateAspectRatio(this.config.defaultAspectRatio)) {
      return this.config.defaultAspectRatio;
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
      const sanitizeObject = (obj: any): any => {
        if (!obj || typeof obj !== 'object') {
          return obj;
        }

        if (Array.isArray(obj)) {
          return obj.map((item) => sanitizeObject(item));
        }

        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
          // Truncate any long string fields (base64 data, signatures, etc.)
          if (typeof value === 'string' && value.length > 200) {
            // Truncate long strings (base64 data, thoughtSignature, etc.)
            result[key] = `${value.substring(0, 50)}... [${value.length} chars truncated]`;
          } else if (key === 'inlineData' && value && typeof value === 'object' && 'data' in value) {
            // Handle inlineData.data specifically
            const dataValue = (value as any).data;
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
      // If JSON parsing fails, return a simple representation
      return { ...(response as object), _error: 'Failed to sanitize response for logging' };
    }
  }

  /**
   * Load image and convert to base64
   * Supports URL, file path, or base64 string
   */
  private async loadImageAsBase64(image: string): Promise<{ data: string; mimeType: string }> {
    try {
      // Use ResourceDownloader to handle various input formats
      const base64Data = await ResourceDownloader.downloadToBase64(image, {
        timeout: 30000, // 30 seconds timeout
        maxSize: 10 * 1024 * 1024, // 10MB max size
      });

      // Try to infer MIME type from the input
      let mimeType = 'image/jpeg'; // Default
      if (image.startsWith('data:')) {
        // Extract MIME type from data URL
        const match = image.match(/data:([^;]+)/);
        if (match) {
          mimeType = match[1];
        }
      } else if (image.toLowerCase().endsWith('.png')) {
        mimeType = 'image/png';
      } else if (image.toLowerCase().endsWith('.jpg') || image.toLowerCase().endsWith('.jpeg')) {
        mimeType = 'image/jpeg';
      } else if (image.toLowerCase().endsWith('.webp')) {
        mimeType = 'image/webp';
      }

      return {
        data: base64Data,
        mimeType,
      };
    } catch (error) {
      logger.error(`[LaozhangProvider] Failed to load image: ${image}`, error);
      throw new Error(`Failed to load image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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
      const model = options?.model || this.config.model || LaozhangProvider.DEFAULT_MODEL;
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
      const candidate = response.candidates![0]!;

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
      const parts = candidate.content!.parts!;

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
   * Transform image based on prompt (image-to-image)
   * Supports single image input
   */
  async transformImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('LaozhangProvider is not available: apiKey not configured');
    }

    try {
      logger.info(`[LaozhangProvider] Starting image-to-image transformation for prompt: ${prompt}`);

      const model = this.config.model || LaozhangProvider.DEFAULT_MODEL;
      const aspectRatio = this.resolveAspectRatioForImage2Image(options);
      const imageSize = this.resolveImageSize(options);

      logger.info(`[LaozhangProvider] Parameters: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}`);

      // Load input image and convert to base64
      const { data: imageBase64, mimeType: imageMimeType } = await this.loadImageAsBase64(image);

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
      const candidate = response.candidates![0]!;

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
      const parts = candidate.content!.parts!;

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
