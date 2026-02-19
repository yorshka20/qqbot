// Google Cloud Run ComfyUI Provider - T2I (text-to-image) via synchronous workflow API

import { ComfyUICloudRunClient } from '@/googlecloud';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';

export interface GoogleCloudRunProviderOptions {
  /** Cloud Run service URL (e.g. https://comfyui-serverless-xxx.run.app). */
  baseUrl: string;
  /** Optional Bearer token for authenticated Cloud Run or API gateway. */
  apiKey?: string;
  /** Request timeout in ms (default from client). */
  timeoutMs?: number;
}

/**
 * Google Cloud Run provider: text2img via ComfyUI sync POST workflow API.
 * T2I only; no I2V.
 */
export class GoogleCloudRunProvider extends AIProvider implements Text2ImageCapability {
  readonly name = 'google-cloud-run';
  private options: GoogleCloudRunProviderOptions;
  private _capabilities: CapabilityType[] = ['text2img'];

  constructor(options: GoogleCloudRunProviderOptions) {
    super();
    this.options = { ...options };
    logger.info('[GoogleCloudRunProvider] Initialized', {
      baseUrl: options.baseUrl,
    });
  }

  isAvailable(): boolean {
    return !!this.options.baseUrl?.trim();
  }

  async checkAvailability(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    const client = new ComfyUICloudRunClient(this.options.baseUrl, {
      apiKey: this.options.apiKey,
      timeoutMs: this.options.timeoutMs,
    });
    return client.healthCheck();
  }

  getConfig(): Record<string, unknown> {
    return {
      baseUrl: this.options.baseUrl,
      timeoutMs: this.options.timeoutMs,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  /** T2I: sync POST workflow to Cloud Run, return first image. */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('GoogleCloudRunProvider is not available: baseUrl must be set');
    }
    const client = new ComfyUICloudRunClient(this.options.baseUrl, {
      apiKey: this.options.apiKey,
      timeoutMs: this.options.timeoutMs,
    });
    const imageBuffer = await client.generateImage(prompt, options);
    return {
      images: [{ base64: imageBuffer.toString('base64') }],
      metadata: { prompt, provider: this.name },
    };
  }
}
