// NovelAI Provider implementation

import type { NovelAIProviderConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { ResourceDownloader } from '../utils/ResourceDownloader';
import AdmZip from 'adm-zip';
import { mkdir, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { AIProvider } from '../base/AIProvider';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2ImageOptions,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';
import { resizeImageToBase64 } from '../utils/imageResize';

/**
 * NovelAI Provider implementation
 * Text-to-image and image-to-image generation using NovelAI API (V4+ only)
 */
export class NovelAIProvider extends AIProvider implements Text2ImageCapability, Image2ImageCapability {
  readonly name = 'novelai';
  private config: NovelAIProviderConfig;
  private _capabilities: CapabilityType[];

  private outputPath = join(process.cwd(), 'output', 'novelai');

  // Basic defaults for V4.5
  private static readonly DEFAULT_STEPS = 28;
  private static readonly DEFAULT_WIDTH = 832;
  private static readonly DEFAULT_HEIGHT = 1216;
  private static readonly DEFAULT_GUIDANCE_SCALE = 5.0;

  constructor(config: NovelAIProviderConfig) {
    super();
    this.config = {
      baseURL: 'https://image.novelai.net',
      defaultSteps: NovelAIProvider.DEFAULT_STEPS,
      defaultWidth: NovelAIProvider.DEFAULT_WIDTH,
      defaultHeight: NovelAIProvider.DEFAULT_HEIGHT,
      defaultGuidanceScale: NovelAIProvider.DEFAULT_GUIDANCE_SCALE,
      ...config,
    };

    this._capabilities = ['text2img', 'img2img'];

    logger.info('[NovelAIProvider] Initialized');
  }

  isAvailable(): boolean {
    return !!this.config.accessToken;
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    return true;
  }

  getConfig(): Record<string, unknown> {
    return {
      baseURL: this.config.baseURL,
      defaultSteps: this.config.defaultSteps,
      defaultWidth: this.config.defaultWidth,
      defaultHeight: this.config.defaultHeight,
      defaultGuidanceScale: this.config.defaultGuidanceScale,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /**
   * Save image data to local file
   * Supports both Buffer and base64 string input
   * @returns Relative path from output directory (e.g., 'novelai/image.png') or null if save failed
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
      const relativePath = `novelai/${filename}`;

      logger.info(`[NovelAIProvider] Saved image to: ${filepath} (${imageBuffer.length} bytes)`);
      return relativePath;
    } catch (error) {
      logger.warn(
        `[NovelAIProvider] Failed to save image to file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Load image from URL/file/base64 and resize to target dimensions for img2img.
   * Returns raw base64 (no data URL prefix). NovelAI API requires exact resolution or returns 400.
   */
  private async loadAndResizeImageForImg2Img(image: string, width: number, height: number): Promise<string> {
    const base64Data = await ResourceDownloader.downloadToBase64(image, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024,
    });
    return resizeImageToBase64(base64Data, width, height);
  }

  /**
   * Ensure complete download of response data using streaming
   * This prevents incomplete ZIP file downloads that can cause corruption
   */
  private async downloadComplete(response: Response): Promise<Buffer> {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;
    }

    // Merge all chunks
    const allChunks = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      allChunks.set(chunk, position);
      position += chunk.length;
    }

    return Buffer.from(allChunks);
  }

  /**
   * Extract image from NovelAI ZIP response using AdmZip
   * NovelAI returns a ZIP file containing the generated image
   * Reference: nai.md implementation
   *
   * @param buffer Complete ZIP file buffer (must be fully downloaded)
   * @returns Object containing relativePath (preferred) or base64 data (fallback)
   */
  private async extractImageFromZip(buffer: Buffer): Promise<{
    relativePath?: string;
    base64?: string;
  }> {
    logger.info(`[NovelAIProvider] Extracting image from ZIP (${buffer.length} bytes)`);

    // Validate ZIP signature
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      logger.error(`[NovelAIProvider] Invalid ZIP signature: ${buffer.subarray(0, 4).toString('hex')}`);
      throw new Error('Invalid ZIP file - corrupted or incomplete download');
    }

    try {
      logger.info(`[NovelAIProvider] Loading ZIP file with AdmZip...`);
      // Use AdmZip to parse the ZIP file (as per nai.md reference)
      const zip = new AdmZip(buffer);
      const zipEntries = zip.getEntries();

      logger.info(`[NovelAIProvider] Found ${zipEntries.length} entries in ZIP`);

      if (zipEntries.length === 0) {
        throw new Error('No files found in ZIP archive');
      }

      // Find the first image file (PNG or WebP)
      let imageEntry = null;
      for (const entry of zipEntries) {
        const entryName = entry.entryName;
        if (entryName.endsWith('.png') || entryName.endsWith('.webp')) {
          imageEntry = entry;
          break;
        }
      }

      if (!imageEntry) {
        throw new Error('No image file (PNG or WebP) found in ZIP archive');
      }

      logger.info(`[NovelAIProvider] Extracting ${imageEntry.entryName}...`);
      // Extract the image data using AdmZip's getData method
      const imageData = imageEntry.getData();
      const imageBuffer = Buffer.from(imageData);

      logger.info(`[NovelAIProvider] Extracted ${imageBuffer.length} bytes of image data`);

      // Get original filename from ZIP entry
      const originalFilename =
        imageEntry.entryName.split('/').pop() || `image${extname(imageEntry.entryName) || '.png'}`;

      // Save image to local file
      const relativePath = await this.saveImageToFile(imageBuffer, originalFilename);

      // Return relative path if available, otherwise fallback to base64
      if (relativePath) {
        return {
          relativePath,
          base64: undefined,
        };
      } else {
        // Fallback to base64 if file save failed
        const base64Data = imageBuffer.toString('base64');
        logger.info(`[NovelAIProvider] Using base64 fallback (${base64Data.length} chars)`);
        return {
          relativePath: undefined,
          base64: base64Data,
        };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error(`[NovelAIProvider] Failed to extract image from ZIP: ${err.message}`, err);
      throw new Error(`Failed to extract image from ZIP: ${err.message}`);
    }
  }

  /**
   * Create error response for image generation failure
   */
  private createErrorResponse(
    errorMessage: string,
    prompt: string,
    additionalMetadata?: Record<string, unknown>,
  ): ProviderImageGenerationResponse {
    logger.warn(`[NovelAIProvider] ${errorMessage}`);
    return {
      images: [],
      text: errorMessage,
      metadata: {
        prompt,
        error: true,
        ...additionalMetadata,
      },
    };
  }

  /**
   * Handle HTTP error responses from NovelAI API
   */
  private async handleHttpError(response: Response, prompt: string): Promise<ProviderImageGenerationResponse | null> {
    if (response.ok) {
      return null;
    }

    const errorText = await response.text().catch(() => 'Unknown error');
    let errorMessage: string;

    // Parse error response if it's JSON
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.message || errorJson.error || errorText;
    } catch {
      errorMessage = errorText;
    }

    // Create user-friendly error messages for common HTTP errors
    let userFriendlyMessage: string;
    switch (response.status) {
      case 429:
        userFriendlyMessage = '图片生成失败：并发生成被锁定，请稍后再试。NovelAI 同时只能处理一个生成请求。';
        break;
      case 401:
        userFriendlyMessage = '图片生成失败：认证失败，请检查 NovelAI access token 配置。';
        break;
      case 402:
        userFriendlyMessage = '图片生成失败：账户余额不足，请充值后重试。';
        break;
      case 400:
        userFriendlyMessage = `图片生成失败：请求参数错误。${errorMessage}`;
        break;
      case 500:
      case 502:
      case 503:
        userFriendlyMessage = '图片生成失败：NovelAI 服务暂时不可用，请稍后再试。';
        break;
      default:
        userFriendlyMessage = `图片生成失败：HTTP ${response.status}。${errorMessage}`;
    }

    logger.error(`[NovelAIProvider] HTTP ${response.status} error: ${errorMessage}`);

    return this.createErrorResponse(userFriendlyMessage, prompt, {
      httpStatus: response.status,
      errorMessage,
    });
  }

  /**
   * Handle ZIP extraction errors
   */
  private handleExtractionError(error: unknown, prompt: string): ProviderImageGenerationResponse {
    const err = error instanceof Error ? error : new Error('Unknown extraction error');
    logger.error(`[NovelAIProvider] Failed to extract image from ZIP: ${err.message}`, error);
    return this.createErrorResponse(`图片生成失败：无法从 ZIP 文件中提取图片。${err.message}`, prompt, {
      errorType: 'ExtractionError',
      errorMessage: err.message,
    });
  }

  /**
   * Handle case when no image data is available after extraction
   */
  private handleNoImageData(prompt: string): ProviderImageGenerationResponse {
    return this.createErrorResponse('图片生成失败：无法提取图片数据，请重试。', prompt, {
      errorMessage: 'Failed to extract image: no relative path or base64 data available',
    });
  }

  /**
   * Handle general errors (from catch blocks)
   */
  private handleGeneralError(error: unknown, prompt: string): ProviderImageGenerationResponse {
    const err = error instanceof Error ? error : new Error('Unknown error');
    logger.error(`[NovelAIProvider] Generation failed: ${err.message}`, err);
    return this.createErrorResponse(`图片生成失败：${err.message}`, prompt, {
      errorType: err.name || 'Error',
      errorMessage: err.message,
    });
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    try {
      logger.info(`[NovelAIProvider] Starting image generation for prompt: ${prompt}`);

      const width = options?.width || this.config.defaultWidth;
      const height = options?.height || this.config.defaultHeight;
      const guidanceScale = options?.guidance_scale || this.config.defaultGuidanceScale;
      const seed =
        options?.seed !== undefined && options.seed >= 0 ? options.seed : Math.floor(Math.random() * 4294967295);
      // V4+ models only
      const model = this.config.model || 'nai-diffusion-4-5-full';

      // Validate model is V4+
      if (!model.startsWith('nai-diffusion-4')) {
        throw new Error(
          `Unsupported model: ${model}. NovelAIProvider only supports V4+ models (e.g., nai-diffusion-4-5-full)`,
        );
      }

      logger.info(
        `[NovelAIProvider] Parameters: model=${model}, size=${width}x${height}, steps=28, scale=${guidanceScale}, seed=${seed}`,
      );

      // Parameters according to latest NovelAI API documentation
      // According to swagger: v4_prompt and v4_negative_prompt are used instead of prompt/negative_prompt
      const parameters: Record<string, unknown> = {
        params_version: 3,
        width: 832,
        height: 1216,
        scale: 5,
        sampler: 'k_euler_ancestral',
        steps: 28,
        seed,
        n_samples: 1,
        strength: 0.7,
        noise: 0,
        ucPreset: 1,
        qualityToggle: true,
        autoSmea: false,
        sm: false,
        sm_dyn: false,
        dynamic_thresholding: false,
        controlnet_strength: 1,
        legacy: false,
        add_original_image: true,
        cfg_rescale: 0,
        noise_schedule: 'karras',
        legacy_v3_extend: false,
        skip_cfg_above_sigma: null,
        use_coords: false,
        legacy_uc: false,
        normalize_reference_strength_multiple: true,
        inpaintImg2ImgStrength: 1,
        // V4.5 specific prompt structure (replaces "prompt" field)
        v4_prompt: {
          caption: {
            base_caption: prompt,
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        },
        // V4.5 specific negative prompt structure (replaces "negative_prompt" field)
        v4_negative_prompt: {
          caption: {
            base_caption: options?.negative_prompt || 'low quality, bad anatomy, text, blurry, worst quality',
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        },
      };

      const requestBody: Record<string, unknown> = {
        action: 'generate',
        model,
        input: prompt, // Required input field for the API
        parameters,
      };

      const baseURL = this.config.baseURL || 'https://image.novelai.net';
      // Use /ai/generate-image endpoint as per swagger spec (returns ZIP file)
      const fullUrl = baseURL.endsWith('/') ? `${baseURL}ai/generate-image` : `${baseURL}/ai/generate-image`;

      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/zip', // NovelAI returns ZIP file
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(300000),
      });

      // Handle HTTP errors
      const httpError = await this.handleHttpError(response, prompt);
      if (httpError) {
        return httpError;
      }

      // CRITICAL: Must completely download the ZIP stream before attempting to extract
      // This ensures all chunks are received and prevents corruption
      logger.info(`[NovelAIProvider] Downloading complete ZIP file...`);
      const buffer = await this.downloadComplete(response);
      logger.info(`[NovelAIProvider] ZIP file download complete (${buffer.length} bytes)`);

      // Extract image from ZIP and save to local file
      // extractImageFromZip will handle the complete ZIP buffer and save the first image
      try {
        const { relativePath, base64: base64Image } = await this.extractImageFromZip(buffer);

        // Prefer relative path over base64 for better performance
        if (!relativePath && !base64Image) {
          // This should not happen, but handle it gracefully
          return this.handleNoImageData(prompt);
        }

        const imageData: { relativePath?: string; base64?: string } = {};
        if (relativePath) {
          imageData.relativePath = relativePath;
        } else if (base64Image) {
          imageData.base64 = base64Image;
        }

        return {
          images: [imageData],
          metadata: { prompt, numImages: 1, width, height, steps: 28, guidanceScale },
        };
      } catch (extractError) {
        return this.handleExtractionError(extractError, prompt);
      }
    } catch (error) {
      // Return error response instead of throwing for better user experience
      // Only throw for truly unexpected errors (like network failures during ZIP download)
      // HTTP errors are already handled above
      return this.handleGeneralError(error, prompt);
    }
  }

  /**
   * Generate image from image (img2img). API requires action 'img2img' when parameters.image is present
   * (action 'generate' is rejected with "image is not allowed for regular generations").
   * Parameters: image (raw base64), strength, noise. Input image is resized to target resolution.
   */
  async generateImageFromImage(
    image: string,
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    try {
      logger.info(`[NovelAIProvider] Starting img2img for prompt: ${prompt}`);

      const width = options?.width ?? this.config.defaultWidth ?? NovelAIProvider.DEFAULT_WIDTH;
      const height = options?.height ?? this.config.defaultHeight ?? NovelAIProvider.DEFAULT_HEIGHT;
      const seed =
        typeof options?.seed === 'number' && options.seed >= 0
          ? options.seed
          : Math.floor(Math.random() * 4294967295);
      const model = this.config.model || 'nai-diffusion-4-5-full';

      if (!model.startsWith('nai-diffusion-4')) {
        throw new Error(
          `Unsupported model: ${model}. NovelAIProvider only supports V4+ models (e.g., nai-diffusion-4-5-full)`,
        );
      }

      const strength = options?.strength ?? this.config.defaultStrength ?? 0.5;
      const noise = options?.noise ?? this.config.defaultNoise ?? 0;

      logger.info(
        `[NovelAIProvider] img2img params: model=${model}, size=${width}x${height}, strength=${strength}, seed=${seed}`,
      );

      const imageBase64 = await this.loadAndResizeImageForImg2Img(image, width, height);

      const parameters: Record<string, unknown> = {
        params_version: 3,
        width,
        height,
        scale: 5,
        sampler: 'k_euler_ancestral',
        steps: 28,
        seed,
        n_samples: 1,
        ucPreset: 1,
        qualityToggle: true,
        autoSmea: false,
        sm: false,
        sm_dyn: false,
        dynamic_thresholding: false,
        controlnet_strength: 1,
        legacy: false,
        add_original_image: true,
        cfg_rescale: 0,
        noise_schedule: 'karras',
        legacy_v3_extend: false,
        skip_cfg_above_sigma: null,
        use_coords: false,
        legacy_uc: false,
        normalize_reference_strength_multiple: true,
        inpaintImg2ImgStrength: 1,
        image: imageBase64,
        strength,
        noise,
        v4_prompt: {
          caption: { base_caption: prompt, char_captions: [] },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: {
            base_caption:
              (options?.negative_prompt as string | undefined) ||
              'low quality, bad anatomy, text, blurry, worst quality',
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        },
      };

      const requestBody: Record<string, unknown> = {
        action: 'img2img',
        model,
        input: prompt,
        parameters,
      };

      const baseURL = this.config.baseURL || 'https://image.novelai.net';
      const fullUrl = baseURL.endsWith('/') ? `${baseURL}ai/generate-image` : `${baseURL}/ai/generate-image`;

      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/zip',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(300000),
      });

      const httpError = await this.handleHttpError(response, prompt);
      if (httpError) {
        return httpError;
      }

      logger.info(`[NovelAIProvider] Downloading complete ZIP file...`);
      const buffer = await this.downloadComplete(response);
      logger.info(`[NovelAIProvider] ZIP file download complete (${buffer.length} bytes)`);

      try {
        const { relativePath, base64: base64Image } = await this.extractImageFromZip(buffer);
        if (!relativePath && !base64Image) {
          return this.handleNoImageData(prompt);
        }
        const imageData: { relativePath?: string; base64?: string } = {};
        if (relativePath) {
          imageData.relativePath = relativePath;
        } else if (base64Image) {
          imageData.base64 = base64Image;
        }
        return {
          images: [imageData],
          metadata: { prompt, numImages: 1, width, height, steps: 28, strength, noise },
        };
      } catch (extractError) {
        return this.handleExtractionError(extractError, prompt);
      }
    } catch (error) {
      return this.handleGeneralError(error, prompt);
    }
  }
}
