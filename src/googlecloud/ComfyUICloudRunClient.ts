// ComfyUI Cloud Run client - synchronous POST workflow API (no job id, no polling).

import type { Text2ImageOptions } from '@/ai/capabilities/types';
import { buildT2IWorkflow } from '@/runpod/t2iWorkflow';
import { logger } from '@/utils/logger';

export interface ComfyUICloudRunClientOptions {
  /** Optional Bearer token for authenticated Cloud Run or API gateway. */
  apiKey?: string;
  /** Request timeout in ms (default 300_000 = 5 min). */
  timeoutMs?: number;
}

/** Response from POST / with workflow (ComfyUI Cloud Run format). */
interface CloudRunWorkflowResponse {
  status?: string;
  outputs?: Array<{ type?: string; data?: string; filename?: string }>;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export class ComfyUICloudRunClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private timeoutMs: number;

  constructor(baseUrl: string, options?: ComfyUICloudRunClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = options?.apiKey?.trim();
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET {baseUrl}/health - return true on 2xx.
   */
  async healthCheck(): Promise<boolean> {
    const url = `${this.baseUrl}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
      });
      return res.ok;
    } catch (e) {
      logger.debug('[ComfyUICloudRunClient] healthCheck failed', {
        url,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Build T2I workflow, POST {baseUrl} with { workflow }, parse first image from outputs.
   */
  async generateImage(prompt: string, options?: Text2ImageOptions): Promise<Buffer> {
    const workflow = buildT2IWorkflow({
      prompt,
      negative_prompt: options?.negative_prompt,
      seed: options?.seed,
      width: options?.width,
      height: options?.height,
      steps: options?.steps,
      guidance_scale: options?.guidance_scale,
      cfg_scale: options?.cfg_scale,
    });

    const url = this.baseUrl;
    const body = JSON.stringify({ workflow });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    logger.info('[ComfyUICloudRunClient] POST workflow (T2I)', {
      seed: options?.seed,
      width: options?.width,
      height: options?.height,
      steps: options?.steps,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI Cloud Run request failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as CloudRunWorkflowResponse;

    if (data.status !== 'success' && data.status != null) {
      const msg = data.message ?? data.status;
      throw new Error(`ComfyUI Cloud Run returned non-success: ${msg}`);
    }

    const outputs = data.outputs ?? [];
    // Accept either { type: 'image', data } or RunPod-style { data } (first with data)
    const firstImage = outputs.find(
      (o) => (o.type === 'image' && o.data) || (o.data && !o.type),
    );
    if (!firstImage?.data || typeof firstImage.data !== 'string') {
      throw new Error(
        data.message
          ? `ComfyUI Cloud Run: ${data.message}`
          : 'ComfyUI Cloud Run completed but no image in outputs',
      );
    }

    logger.info('[ComfyUICloudRunClient] T2I done, decoding image');
    return Buffer.from(firstImage.data, 'base64');
  }
}
