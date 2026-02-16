// RunPod Serverless client - submit I2V job via RunPod v2 API, poll status, return video buffer.
// T2I: submit workflow with images: [], get image buffer from output.
// Handler contract: input { workflow, images: [{ name, image: base64 }] }; output { outputs: [{ data: base64 }] } or { error }.

import type { Text2ImageOptions } from '@/ai/capabilities/types';
import { logger } from '@/utils/logger';
import { buildT2IWorkflow } from './t2iWorkflow';
import { buildWan22I2VRemixWorkflow } from './wan22Workflow';

const RUNPOD_API_BASE = 'https://api.runpod.ai/v2';

/** Response from POST /run */
interface RunResponse {
  id?: string;
  status?: string;
}

/** Response from GET /status/{id}; output is the handler return value */
interface StatusResponse {
  id?: string;
  status: string;
  output?: {
    /** runpod-worker-comfyui format */
    images?: Array<{ filename?: string; type?: string; data?: string }>;
    outputs?: Array<{ data?: string; format?: string; filename?: string }>;
    error?: string;
  };
}

export interface RunPodServerlessClientOptions {
  /** Max time to wait for job completion (default 600_000 ms = 10 min) */
  timeoutMs?: number;
  /** Poll interval for status (default 5_000 ms) */
  pollIntervalMs?: number;
}

export class RunPodServerlessClient {
  private endpointId: string;
  private apiKey: string;
  private timeoutMs: number;
  private pollIntervalMs: number;

  constructor(
    endpointId: string,
    apiKey: string | undefined,
    options?: RunPodServerlessClientOptions,
  ) {
    this.endpointId = endpointId.replace(/\/$/, '');
    const resolved = apiKey ?? process.env.RUNPOD_API_KEY;
    if (!resolved?.trim()) {
      throw new Error(
        'RunPod API key is required: set runpod.apiKey in config or RUNPOD_API_KEY env',
      );
    }
    this.apiKey = resolved.trim();
    this.timeoutMs = options?.timeoutMs ?? 600_000;
    this.pollIntervalMs = options?.pollIntervalMs ?? 5_000;
  }

  private async run(input: { workflow: Record<string, unknown>; images: Array<{ name: string; image: string }> }): Promise<string> {
    const url = `${RUNPOD_API_BASE}/${this.endpointId}/run`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RunPod run failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as RunResponse;
    if (!data.id) {
      throw new Error(`RunPod run returned no job id: ${JSON.stringify(data)}`);
    }
    return data.id;
  }

  private async getStatus(jobId: string): Promise<StatusResponse> {
    const url = `${RUNPOD_API_BASE}/${this.endpointId}/status/${jobId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RunPod status failed: ${res.status} ${text}`);
    }
    return (await res.json()) as StatusResponse;
  }

  /**
   * Poll status until COMPLETED, FAILED, TIMED_OUT, or timeout.
   * Returns the status response (with output when COMPLETED).
   */
  private async waitForCompletion(jobId: string): Promise<StatusResponse> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(this.pollIntervalMs);
      const statusRes = await this.getStatus(jobId);
      const status = statusRes.status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'TIMED_OUT' || status === 'CANCELLED') {
        return statusRes;
      }
      logger.debug('[RunPodServerlessClient] Poll status', { jobId, status });
    }
    throw new Error(
      `RunPod job ${jobId} did not complete within ${this.timeoutMs / 1000}s`,
    );
  }

  /**
   * Full flow: build Wan22-I2V-Remix workflow, send image as base64, POST /run, poll /status, decode video from output.
   * Same signature as ComfyUIClient.generateVideoFromImage for drop-in use.
   */
  async generateVideoFromImage(
    imageBuffer: Buffer,
    prompt: string,
    options?: { seed?: number; durationSeconds?: number; negativePrompt?: string },
  ): Promise<Buffer> {
    const filename = `input_${Date.now()}.png`;
    const workflow = buildWan22I2VRemixWorkflow(filename, { prompt, ...options });
    const imageBase64 = imageBuffer.toString('base64');
    const images = [{ name: filename, image: imageBase64 }];

    logger.info('[RunPodServerlessClient] Submitting job', { seed: options?.seed, durationSeconds: options?.durationSeconds, prompt });

    const jobId = await this.run({ workflow, images });

    logger.info('[RunPodServerlessClient] Waiting for job', { jobId });
    const statusRes = await this.waitForCompletion(jobId);

    if (statusRes.status === 'FAILED' || statusRes.status === 'TIMED_OUT' || statusRes.status === 'CANCELLED') {
      const errMsg = statusRes.output?.error ?? statusRes.status;
      logger.error(
        `[RunPodServerlessClient] Job failed | jobId=${jobId} | status=${statusRes.status} | output=${JSON.stringify(statusRes.output ?? null)}`,
      );
      throw new Error(`RunPod job failed: ${errMsg}`);
    }

    const output = statusRes.output;
    // Handle runpod-worker-comfyui format: { images: [{ data }] } or { outputs: [{ data }] }
    const items = output?.images ?? output?.outputs ?? [];
    if (!items.length) {
      throw new Error('RunPod job completed but no outputs in response');
    }
    const first = items[0];
    const dataB64 = first?.data;
    if (!dataB64 || typeof dataB64 !== 'string') {
      throw new Error('RunPod output missing data (base64 video)');
    }

    logger.info('[RunPodServerlessClient] Job done, decoding video', { jobId });
    return Buffer.from(dataB64, 'base64');
  }

  /**
   * Full flow: build T2I workflow, POST /run with empty images, poll /status, decode first image from output.
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

    logger.info('[RunPodServerlessClient] Submitting T2I job', {
      seed: options?.seed,
      width: options?.width,
      height: options?.height,
      steps: options?.steps,
    });
    const jobId = await this.run({ workflow, images: [] });

    logger.info('[RunPodServerlessClient] Waiting for T2I job', { jobId });
    const statusRes = await this.waitForCompletion(jobId);

    if (statusRes.status === 'FAILED' || statusRes.status === 'TIMED_OUT' || statusRes.status === 'CANCELLED') {
      const errMsg = statusRes.output?.error ?? statusRes.status;
      logger.error(
        `[RunPodServerlessClient] T2I job failed | jobId=${jobId} | status=${statusRes.status} | output=${JSON.stringify(statusRes.output ?? null)}`,
      );
      throw new Error(`RunPod job failed: ${errMsg}`);
    }

    const output = statusRes.output;
    const items = output?.images ?? output?.outputs ?? [];
    if (!items.length) {
      throw new Error('RunPod job completed but no outputs in response');
    }
    const first = items[0];
    const dataB64 = first?.data;
    if (!dataB64 || typeof dataB64 !== 'string') {
      throw new Error('RunPod output missing data (base64 image)');
    }

    logger.info('[RunPodServerlessClient] T2I job done, decoding image', { jobId });
    return Buffer.from(dataB64, 'base64');
  }
}
