// RunPod Serverless Provider - T2I (text-to-image) and I2V (image-to-video) via ComfyUI

import { RunPodServerlessClient, type RunPodServerlessClientOptions } from '@/runpod';
import { logger } from '@/utils/logger';
import { AIProvider } from '../base/AIProvider';
import type { Image2VideoCapability } from '../capabilities/Image2VideoCapability';
import type { Text2ImageCapability } from '../capabilities/Text2ImageCapability';
import type {
  CapabilityType,
  Image2VideoOptions,
  ProviderImageGenerationResponse,
  Text2ImageOptions,
} from '../capabilities/types';

export interface RunPodProviderOptions {
  /** I2V endpoint ID (and T2I if t2iEndpointId not set) */
  endpointId: string;
  apiKey: string;
  /** Optional T2I-only endpoint; if not set, endpointId is used for T2I */
  t2iEndpointId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * RunPod provider: text2img and i2v via RunPod Serverless ComfyUI.
 * - T2I: uses t2iEndpointId ?? endpointId
 * - I2V: uses endpointId
 */
export class RunPodProvider extends AIProvider implements Text2ImageCapability, Image2VideoCapability {
  readonly name = 'runpod';
  private options: RunPodProviderOptions;
  private _capabilities: CapabilityType[] = ['text2img', 'i2v'];

  constructor(options: RunPodProviderOptions) {
    super();
    this.options = { ...options };
    logger.info('[RunPodProvider] Initialized', {
      endpointId: options.endpointId,
      t2iEndpointId: options.t2iEndpointId,
    });
  }

  isAvailable(): boolean {
    return !!this.options.endpointId?.trim() && !!this.options.apiKey?.trim();
  }

  async checkAvailability(): Promise<boolean> {
    return this.isAvailable();
  }

  getConfig(): Record<string, unknown> {
    return {
      endpointId: this.options.endpointId,
      t2iEndpointId: this.options.t2iEndpointId,
      timeoutMs: this.options.timeoutMs,
      pollIntervalMs: this.options.pollIntervalMs,
    };
  }

  getCapabilities(): CapabilityType[] {
    return this._capabilities;
  }

  private clientOptions(): RunPodServerlessClientOptions {
    const o: RunPodServerlessClientOptions = {};
    if (this.options.timeoutMs != null) o.timeoutMs = this.options.timeoutMs;
    if (this.options.pollIntervalMs != null) o.pollIntervalMs = this.options.pollIntervalMs;
    return o;
  }

  /** T2I: use t2iEndpointId ?? endpointId */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<ProviderImageGenerationResponse> {
    if (!this.isAvailable()) {
      throw new Error('RunPodProvider is not available: endpointId and apiKey must be set');
    }
    const endpointId = this.options.t2iEndpointId ?? this.options.endpointId;
    const client = new RunPodServerlessClient(endpointId, this.options.apiKey, this.clientOptions());
    const imageBuffer = await client.generateImage(prompt, options);
    return {
      images: [{ base64: imageBuffer.toString('base64') }],
      metadata: { prompt, provider: this.name },
    };
  }

  /** I2V: use endpointId */
  async generateVideoFromImage(
    imageBuffer: Buffer,
    prompt: string,
    options?: Image2VideoOptions,
  ): Promise<Buffer> {
    if (!this.isAvailable()) {
      throw new Error('RunPodProvider is not available: endpointId and apiKey must be set');
    }
    const client = new RunPodServerlessClient(
      this.options.endpointId,
      this.options.apiKey,
      this.clientOptions(),
    );
    return client.generateVideoFromImage(imageBuffer, prompt, options);
  }
}
