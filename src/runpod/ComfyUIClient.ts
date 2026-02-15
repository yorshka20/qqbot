// ComfyUI client - upload image, submit Wan2.2 I2V Remix workflow, poll, download video.
// Uses native fetch for FormData (upload) and binary (view); no shared HttpClient.

import { logger } from '@/utils/logger';
import { buildWan22I2VRemixWorkflow } from './wan22Workflow';

/** ComfyUI output file entry (filename, subfolder, type) */
interface ComfyUIOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

/** ComfyUI job history entry (subset we use) */
interface ComfyUIHistoryJob {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<
    string,
    {
      videos?: ComfyUIOutputFile[];
      gifs?: ComfyUIOutputFile[];
      /** SaveVideo can also return video as images (with animated: true) */
      images?: ComfyUIOutputFile[];
    }
  >;
}

/** ComfyUI /upload/image response */
interface UploadImageResponse {
  name: string;
}

/** ComfyUI /prompt response */
interface PromptResponse {
  prompt_id: string;
}

export interface ComfyUIClientOptions {
  /** Max time to wait for job completion (default 600_000 ms = 10 min) */
  timeoutMs?: number;
  /** Poll interval for history (default 3_000 ms) */
  pollIntervalMs?: number;
}

export class ComfyUIClient {
  private baseUrl: string;
  private timeoutMs: number;
  private pollIntervalMs: number;

  constructor(baseUrl: string, options?: ComfyUIClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = options?.timeoutMs ?? 600_000;
    this.pollIntervalMs = options?.pollIntervalMs ?? 3_000;
  }

  /**
   * Check connectivity to ComfyUI (GET /system_stats).
   * Returns true if the server responds with ok.
   */
  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Upload image to ComfyUI; returns the internal filename to use in the workflow.
   */
  async uploadImage(imageBuffer: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([imageBuffer]), filename);
    form.append('overwrite', 'true');

    const res = await fetch(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      throw new Error(`ComfyUI upload failed: ${res.status}`);
    }
    const data = (await res.json()) as UploadImageResponse;
    return data.name;
  }

  /**
   * Submit workflow to ComfyUI; returns prompt_id.
   */
  async submitPrompt(workflow: Record<string, { inputs: Record<string, unknown>; class_type: string }>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
    });
    if (!res.ok) {
      throw new Error(`ComfyUI submit failed: ${res.status}`);
    }
    const data = (await res.json()) as PromptResponse;
    return data.prompt_id;
  }

  /**
   * Poll /history until job completes or errors or timeout.
   */
  async waitForCompletion(promptId: string): Promise<ComfyUIHistoryJob> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(this.pollIntervalMs);
      const res = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (!res.ok) {
        logger.warn('[ComfyUIClient] History request failed', { status: res.status, promptId });
        continue;
      }
      const raw = await res.json();
      const history = raw != null && typeof raw === 'object' ? (raw as Record<string, ComfyUIHistoryJob>) : null;
      const job = history?.[promptId];
      if (!job) {
        continue;
      }
      if (job.status?.status_str === 'error') {
        const errMsg = job.status.messages?.find((m: unknown) => Array.isArray(m) && m[0] === 'execution_error');
        throw new Error(`ComfyUI job error: ${JSON.stringify(errMsg)}`);
      }
      if (job.status?.completed) {
        return job;
      }
    }
    throw new Error(`ComfyUI job ${promptId} did not complete within ${this.timeoutMs / 1000}s`);
  }

  /**
   * Download video from job output. Wan22-I2V-Remix uses SaveVideo node 117.
   * Old wan22_remix_i2v uses node 108; try both for compatibility.
   */
  async downloadVideo(job: ComfyUIHistoryJob): Promise<Buffer> {
    const output = job.outputs?.['117'] ?? job.outputs?.['108'];
    if (!output) {
      logger.error('[ComfyUIClient] SaveVideo output (node 117/108) missing in job.outputs', { outputKeys: job.outputs ? Object.keys(job.outputs) : [] });
      throw new Error('ComfyUI SaveVideo output not found');
    }
    // SaveVideo may return videos, gifs, or images (ComfyUI version-dependent)
    const videoInfo = output.videos?.[0] ?? output.gifs?.[0] ?? output.images?.[0];
    const sourceKey = output.videos?.[0] ? 'videos' : output.gifs?.[0] ? 'gifs' : output.images?.[0] ? 'images' : 'none';
    if (!videoInfo) {
      logger.error('[ComfyUIClient] No video entry in output', { output: JSON.stringify(output) });
      throw new Error(`No video in output: ${JSON.stringify(output)}`);
    }
    logger.info('[ComfyUIClient] Downloading from /view', { sourceKey, filename: videoInfo.filename, subfolder: videoInfo.subfolder, type: videoInfo.type });
    const { filename, subfolder, type } = videoInfo;
    const url = `${this.baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.error('[ComfyUIClient] /view request failed', { status: res.status, url });
      throw new Error(`ComfyUI download failed: ${res.status} ${url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Full flow: upload image, submit Wan2.2 I2V Remix workflow, wait for completion, download video.
   * Public entry for callers (e.g. future command handler).
   */
  async animateImage(
    imageBuffer: Buffer,
    prompt: string,
    options?: { seed?: number; durationSeconds?: number; negativePrompt?: string },
  ): Promise<Buffer> {
    const seed = options?.seed ?? Math.floor(Math.random() * 2 ** 32);
    const durationSeconds = Math.max(1, Math.min(15, options?.durationSeconds ?? 5));
    const filename = `input_${Date.now()}.png`;

    logger.info('[ComfyUIClient] Uploading image...');
    const uploadedName = await this.uploadImage(imageBuffer, filename);

    logger.info('[ComfyUIClient] Submitting job', { seed, durationSeconds });
    const workflow = buildWan22I2VRemixWorkflow(uploadedName, prompt, seed, durationSeconds, {
      negativePrompt: options?.negativePrompt,
    });
    const promptId = await this.submitPrompt(workflow);

    logger.info('[ComfyUIClient] Waiting for job', { promptId });
    const job = await this.waitForCompletion(promptId);

    logger.info('[ComfyUIClient] Job done, downloading video', { promptId });
    return this.downloadVideo(job);
  }
}
