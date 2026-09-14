// NovelAI Provider implementation

import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import AdmZip from 'adm-zip';
import type { NovelAIProviderConfig } from '@/core/config';
import { logger } from '@/utils/logger';
import { getRepoRoot } from '@/utils/repoRoot';
import { AIProvider } from '../base/AIProvider';
import type { Image2ImageCapability } from '../capabilities/Image2ImageCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2ImageOptions,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';
import { resizeImageToBase64WithMaxSide } from '../utils/imageResize';
import { ResourceDownloader } from '../utils/ResourceDownloader';

/**
 * Guidance scale the NovelAI web client defaults to, per model. Doubles as the set of
 * accepted models: the inpainting checkpoints are left out because this provider has no
 * mask input, so the `infill` action is unreachable.
 */
const MODEL_DEFAULT_SCALE: Record<string, number> = {
  'nai-diffusion-4-5-curated': 5,
  'nai-diffusion-4-5-full': 5,
  'nai-diffusion-4-curated-preview': 5.5,
  'nai-diffusion-4-full': 5.5,
  'nai-diffusion-5-curated': 7,
  'nai-diffusion-5-full': 7,
};

/**
 * NovelAI Provider implementation
 * Text-to-image and image-to-image generation using NovelAI API (V4+ only)
 */
export class NovelAIProvider extends AIProvider implements Text2ImageCapability, Image2ImageCapability {
  readonly name = 'novelai';
  private config: NovelAIProviderConfig;
  private _capabilities: CapabilityType[];

  private outputPath = join(getRepoRoot(), 'output', 'novelai');

  /** Serialize API requests: NovelAI allows only one concurrent request. */
  private requestQueue: Promise<void> = Promise.resolve();

  private static readonly DEFAULT_BASE_URL = 'https://image.novelai.net';
  private static readonly DEFAULT_MODEL = 'nai-diffusion-5-full';
  private static readonly DEFAULT_STEPS = 23;
  private static readonly DEFAULT_WIDTH = 832;
  private static readonly DEFAULT_HEIGHT = 1216;

  /** The only sampler this provider emits; every other wire default below is derived from it. */
  private static readonly SAMPLER = 'k_euler_ancestral';

  /** Dimensions must be multiples of 64. */
  private static readonly SIZE_ALIGN = 64;

  /**
   * Bounds of the Opus image allowance. A generation is covered by it only while it stays at
   * a single sample within `width * height <= 1048576` and `steps <= 28`; crossing either
   * bound silently bills the request in Anlas instead. Callers reach this provider through
   * shared, cross-provider option plumbing that knows nothing about NovelAI's pricing, so the
   * request is clamped here rather than trusted.
   */
  private static readonly FREE_MAX_PIXELS = 1048576;
  private static readonly FREE_MAX_STEPS = 28;

  private static readonly DEFAULT_NEGATIVE_PROMPT = 'low quality, bad anatomy, text, blurry, worst quality';

  constructor(config: NovelAIProviderConfig) {
    super();
    this.config = config;

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
   * Run a function after all previously queued requests finish.
   * Ensures only one NovelAI API request runs at a time.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.requestQueue;
    let resolveNext!: () => void;
    this.requestQueue = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    return prev.then(() =>
      fn().finally(() => {
        resolveNext();
      }),
    );
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

  /** Max dimension for img2img input: scale proportionally, longest side not exceeding this. */
  private static readonly IMG2IMG_MAX_SIDE = 832;
  private static readonly IMG2IMG_ALIGN = 64;

  /**
   * Load image from URL/file/base64 and resize proportionally so the longest side does not exceed IMG2IMG_MAX_SIDE.
   * Returns raw base64 and actual dimensions. NovelAI API requires parameters.width/height to match image size.
   */
  private async loadAndResizeImageForImg2Img(
    image: string,
  ): Promise<{ base64: string; width: number; height: number }> {
    const base64Data = await ResourceDownloader.downloadToBase64(image, {
      timeout: 30000,
      maxSize: 10 * 1024 * 1024,
      filename: `novelai_image_${Date.now()}`,
    });
    return resizeImageToBase64WithMaxSide(base64Data, NovelAIProvider.IMG2IMG_MAX_SIDE, NovelAIProvider.IMG2IMG_ALIGN);
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

  /** NovelAI rejects dimensions that are not multiples of 64. */
  private static alignSize(value: number): number {
    const aligned = Math.round(value / NovelAIProvider.SIZE_ALIGN) * NovelAIProvider.SIZE_ALIGN;
    return Math.max(NovelAIProvider.SIZE_ALIGN, aligned);
  }

  /** Align downwards, so the result can only ever shrink the area it is applied to. */
  private static floorSize(value: number): number {
    const aligned = Math.floor(value / NovelAIProvider.SIZE_ALIGN) * NovelAIProvider.SIZE_ALIGN;
    return Math.max(NovelAIProvider.SIZE_ALIGN, aligned);
  }

  /**
   * Shrink a request until it fits the Opus allowance. Both sides scale by the same factor so
   * the aspect ratio survives, and each floors to a multiple of 64 — flooring only ever loses
   * area, so the result cannot land back above the pixel bound.
   */
  private static clampToFreeAllowance(
    width: number,
    height: number,
    steps: number,
  ): { width: number; height: number; steps: number } {
    const clampedSteps = Math.min(steps, NovelAIProvider.FREE_MAX_STEPS);
    if (width * height <= NovelAIProvider.FREE_MAX_PIXELS) {
      return { width, height, steps: clampedSteps };
    }
    const ratio = Math.sqrt(NovelAIProvider.FREE_MAX_PIXELS / (width * height));
    return {
      width: NovelAIProvider.floorSize(width * ratio),
      height: NovelAIProvider.floorSize(height * ratio),
      steps: clampedSteps,
    };
  }

  private static randomSeed(): number {
    return Math.floor(Math.random() * 4294967295);
  }

  /**
   * Resolve the model to send and the guidance scale it is tuned for. The scale travels with
   * the model because each generation defaults to a different one (V5 is 7, V4.5 is 5).
   */
  private resolveModel(requested?: string): { model: string; defaultScale: number } {
    const model = requested || this.config.model || NovelAIProvider.DEFAULT_MODEL;
    const defaultScale = MODEL_DEFAULT_SCALE[model];
    if (defaultScale === undefined) {
      throw new Error(
        `Unsupported model: ${model}. NovelAIProvider supports ${Object.keys(MODEL_DEFAULT_SCALE).join(', ')}`,
      );
    }
    return { model, defaultScale };
  }

  /**
   * Build `parameters` in the shape the NovelAI web client sends (params_version 4).
   *
   * `noise_schedule` is karras because V5 overrides the field to karras whatever the sampler,
   * and karras is also what k_euler_ancestral falls back to on V4; the two ancestral-noise
   * switches ride along with that sampler on any non-native schedule. SMEA (`sm`, `sm_dyn`,
   * `autoSmea`) has no field here because no V4-or-later model supports it — the web client
   * drops those keys, and pins `dynamic_thresholding` to false, for the same reason.
   */
  private buildParameters(args: {
    width: number;
    height: number;
    steps: number;
    scale: number;
    seed: number;
    prompt: string;
    negativePrompt: string;
    image?: { base64: string; strength: number; noise: number };
  }): Record<string, unknown> {
    const parameters: Record<string, unknown> = {
      params_version: 4,
      width: args.width,
      height: args.height,
      scale: args.scale,
      sampler: NovelAIProvider.SAMPLER,
      steps: args.steps,
      seed: args.seed,
      n_samples: 1,
      noise_schedule: 'karras',
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      // 'none': NovelAI's undesired-content and quality presets are text the web client
      // prepends locally, so honouring them here would layer tags on top of the caller's
      // prompt instead of leaving it authoritative.
      ucPresetId: 'none',
      qualityPresetId: 'none',
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      legacy_v3_extend: false,
      legacy_uc: false,
      add_original_image: true,
      cfg_rescale: 0,
      use_coords: false,
      normalize_reference_strength_multiple: true,
      inpaintImg2ImgStrength: 1,
      v4_prompt: {
        caption: { base_caption: args.prompt, char_captions: [] },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: args.negativePrompt, char_captions: [] },
        legacy_uc: false,
      },
    };

    if (args.image) {
      // strength and noise are only accepted alongside an input image.
      parameters.image = args.image.base64;
      parameters.strength = args.image.strength;
      parameters.noise = args.image.noise;
    }

    return parameters;
  }

  /**
   * Single exit to the NovelAI API for both actions: POST the request, then unwrap the ZIP
   * archive it answers with.
   */
  private async requestImage(args: {
    action: 'generate' | 'img2img';
    model: string;
    prompt: string;
    parameters: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<ProviderImageGenerationResponse> {
    const { action, model, prompt, parameters, metadata } = args;

    const baseURL = this.config.baseURL ?? NovelAIProvider.DEFAULT_BASE_URL;
    const fullUrl = baseURL.endsWith('/') ? `${baseURL}ai/generate-image` : `${baseURL}/ai/generate-image`;

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/zip',
      },
      body: JSON.stringify({ action, model, input: prompt, parameters }),
      signal: AbortSignal.timeout(300000),
    });

    const httpError = await this.handleHttpError(response, prompt);
    if (httpError) {
      return httpError;
    }

    // The archive must be read to completion before extraction: NovelAI streams it with a
    // data descriptor, so a partial read is indistinguishable from a corrupt ZIP.
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

      return { images: [imageData], metadata };
    } catch (extractError) {
      return this.handleExtractionError(extractError, prompt);
    }
  }

  /**
   * Generate image from text prompt
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    return this.enqueue(async () => {
      try {
        logger.info(`[NovelAIProvider] Starting image generation for prompt: ${prompt}`);

        const { model, defaultScale } = this.resolveModel(options?.model);
        const requestedWidth = NovelAIProvider.alignSize(
          options?.width ?? this.config.defaultWidth ?? NovelAIProvider.DEFAULT_WIDTH,
        );
        const requestedHeight = NovelAIProvider.alignSize(
          options?.height ?? this.config.defaultHeight ?? NovelAIProvider.DEFAULT_HEIGHT,
        );
        const requestedSteps = options?.steps ?? this.config.defaultSteps ?? NovelAIProvider.DEFAULT_STEPS;
        const scale = options?.guidance_scale ?? this.config.defaultGuidanceScale ?? defaultScale;
        const seed = options?.seed !== undefined && options.seed >= 0 ? options.seed : NovelAIProvider.randomSeed();

        const clamped = NovelAIProvider.clampToFreeAllowance(requestedWidth, requestedHeight, requestedSteps);
        const { width, height, steps } = clamped;
        if (width !== requestedWidth || height !== requestedHeight || steps !== requestedSteps) {
          logger.warn(
            `[NovelAIProvider] Clamped to the Opus allowance: ${requestedWidth}x${requestedHeight}@${requestedSteps} steps -> ${width}x${height}@${steps} steps`,
          );
        }

        logger.info(
          `[NovelAIProvider] Parameters: model=${model}, size=${width}x${height}, steps=${steps}, scale=${scale}, seed=${seed}`,
        );

        return await this.requestImage({
          action: 'generate',
          model,
          prompt,
          parameters: this.buildParameters({
            width,
            height,
            steps,
            scale,
            seed,
            prompt,
            negativePrompt: options?.negative_prompt || NovelAIProvider.DEFAULT_NEGATIVE_PROMPT,
          }),
          metadata: { prompt, model, numImages: 1, width, height, steps, guidanceScale: scale, seed },
        });
      } catch (error) {
        return this.handleGeneralError(error, prompt);
      }
    });
  }

  /**
   * Generate image from image (img2img). API requires action 'img2img' when parameters.image is present
   * (action 'generate' is rejected with "image is not allowed for regular generations").
   * Parameters: image (raw base64), strength, noise. Input image is resized to target resolution.
   */
  async generateImageFromImage(
    images: string[],
    prompt: string,
    options?: Image2ImageOptions,
  ): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('NovelAIProvider is not available: accessToken not configured');
    }

    // NovelAI img2img denoises from a single base image; multi-image reference is not supported.
    const image = images[0];
    if (!image) {
      throw new Error('NovelAIProvider.generateImageFromImage requires at least one source image');
    }

    return this.enqueue(async () => {
      try {
        logger.info(`[NovelAIProvider] Starting img2img for prompt: ${prompt}`);

        const { model, defaultScale } = this.resolveModel(options?.model);
        // Steps, scale and size follow the configured defaults and ignore per-call overrides.
        // No img2img is covered by the Opus allowance, so this one always spends Anlas; the
        // price scales with all three, which keeps the amount an operator decision and caps
        // steps at the same ceiling a free generation would get.
        const steps = Math.min(
          this.config.defaultSteps ?? NovelAIProvider.DEFAULT_STEPS,
          NovelAIProvider.FREE_MAX_STEPS,
        );
        const scale = defaultScale;
        const seed =
          typeof options?.seed === 'number' && options.seed >= 0 ? options.seed : NovelAIProvider.randomSeed();
        const strength = options?.strength ?? this.config.defaultStrength ?? 0.5;
        const noise = options?.noise ?? this.config.defaultNoise ?? 0;

        const { base64: imageBase64, width, height } = await this.loadAndResizeImageForImg2Img(image);

        logger.info(
          `[NovelAIProvider] img2img params: model=${model}, size=${width}x${height} (maxSide=${NovelAIProvider.IMG2IMG_MAX_SIDE}), steps=${steps}, scale=${scale}, strength=${strength}, noise=${noise}, seed=${seed}`,
        );

        return await this.requestImage({
          action: 'img2img',
          model,
          prompt,
          parameters: this.buildParameters({
            width,
            height,
            steps,
            scale,
            seed,
            prompt,
            negativePrompt: (options?.negative_prompt as string | undefined) || NovelAIProvider.DEFAULT_NEGATIVE_PROMPT,
            image: { base64: imageBase64, strength, noise },
          }),
          metadata: { prompt, model, numImages: 1, width, height, steps, strength, noise, seed },
        });
      } catch (error) {
        return this.handleGeneralError(error, prompt);
      }
    });
  }
}
