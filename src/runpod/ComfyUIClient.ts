// RunPod ComfyUI client - upload image, submit Wan2.2 I2V workflow, poll, download video.
// Uses native fetch for FormData (upload) and binary (view); no shared HttpClient.

import { logger } from '@/utils/logger';

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

  /** FPS in workflow node 94 (CreateVideo); used to convert durationSeconds to frame count. */
  private static readonly WORKFLOW_FPS = 16;

  /**
   * Build Wan2.2 I2V workflow with parameterized prompt, image filename, seed, and duration.
   * Node IDs match video_wan2_2_14B_i2v API workflow; _meta is omitted.
   * durationSeconds: 1–15, default 5; converted to frame count (length) for node 98.
   */
  private buildWorkflow(
    uploadedFilename: string,
    positivePrompt: string,
    seed: number,
    durationSeconds: number = 5,
  ): Record<string, { inputs: Record<string, unknown>; class_type: string }> {
    const lengthFrames = Math.max(
      16,
      Math.min(240, Math.round(durationSeconds * ComfyUIClient.WORKFLOW_FPS)),
    );
    const negativePrompt =
      '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

    return {
      '84': {
        inputs: {
          clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          type: 'wan',
          device: 'default',
        },
        class_type: 'CLIPLoader',
      },
      '85': {
        inputs: {
          add_noise: 'disable',
          noise_seed: 0,
          steps: 4,
          cfg: 1,
          sampler_name: 'euler',
          scheduler: 'simple',
          start_at_step: 2,
          end_at_step: 4,
          return_with_leftover_noise: 'disable',
          model: ['103', 0],
          positive: ['98', 0],
          negative: ['98', 1],
          latent_image: ['86', 0],
        },
        class_type: 'KSamplerAdvanced',
      },
      '86': {
        inputs: {
          add_noise: 'enable',
          noise_seed: seed,
          steps: 4,
          cfg: 1,
          sampler_name: 'euler',
          scheduler: 'simple',
          start_at_step: 0,
          end_at_step: 2,
          return_with_leftover_noise: 'enable',
          model: ['104', 0],
          positive: ['98', 0],
          negative: ['98', 1],
          latent_image: ['98', 2],
        },
        class_type: 'KSamplerAdvanced',
      },
      '87': {
        inputs: {
          samples: ['85', 0],
          vae: ['90', 0],
        },
        class_type: 'VAEDecode',
      },
      '89': {
        inputs: {
          text: negativePrompt,
          clip: ['84', 0],
        },
        class_type: 'CLIPTextEncode',
      },
      '90': {
        inputs: { vae_name: 'wan_2.1_vae.safetensors' },
        class_type: 'VAELoader',
      },
      '93': {
        inputs: {
          text: positivePrompt,
          clip: ['84', 0],
        },
        class_type: 'CLIPTextEncode',
      },
      '94': {
        inputs: {
          fps: 16,
          images: ['87', 0],
        },
        class_type: 'CreateVideo',
      },
      '96': {
        inputs: {
          unet_name: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
        class_type: 'UNETLoader',
      },
      '97': {
        inputs: {
          image: uploadedFilename,
        },
        class_type: 'LoadImage',
      },
      '98': {
        inputs: {
          width: 640,
          height: 640,
          length: lengthFrames,
          batch_size: 1,
          positive: ['93', 0],
          negative: ['89', 0],
          vae: ['90', 0],
          start_image: ['97', 0],
        },
        class_type: 'WanImageToVideo',
      },
      '101': {
        inputs: {
          lora_name: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
          strength_model: 1.0,
          model: ['116', 0],
        },
        class_type: 'LoraLoaderModelOnly',
      },
      '102': {
        inputs: {
          lora_name: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors',
          strength_model: 1.0,
          model: ['96', 0],
        },
        class_type: 'LoraLoaderModelOnly',
      },
      '103': {
        inputs: { shift: 5.0, model: ['102', 0] },
        class_type: 'ModelSamplingSD3',
      },
      '104': {
        inputs: { shift: 5.0, model: ['101', 0] },
        class_type: 'ModelSamplingSD3',
      },
      '108': {
        inputs: {
          filename_prefix: 'video/ComfyUI',
          format: 'auto',
          codec: 'auto',
          'video-preview': '',
          video: ['94', 0],
        },
        class_type: 'SaveVideo',
      },
      '116': {
        inputs: {
          unet_name: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
        class_type: 'UNETLoader',
      },
    };
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
   * Download video from job output (node 108 SaveVideo); returns raw buffer.
   */
  async downloadVideo(job: ComfyUIHistoryJob): Promise<Buffer> {
    const output = job.outputs?.['108'];
    if (!output) {
      logger.error('[ComfyUIClient] Node 108 missing in job.outputs', { outputKeys: job.outputs ? Object.keys(job.outputs) : [] });
      throw new Error('ComfyUI node 108 output not found');
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
   * Full flow: upload image, submit Wan2.2 I2V workflow, wait for completion, download video.
   * Public entry for callers (e.g. future command handler).
   */
  async animateImage(
    imageBuffer: Buffer,
    prompt: string,
    options?: { seed?: number; durationSeconds?: number },
  ): Promise<Buffer> {
    const seed = options?.seed ?? Math.floor(Math.random() * 2 ** 32);
    const durationSeconds = Math.max(1, Math.min(15, options?.durationSeconds ?? 5));
    const filename = `input_${Date.now()}.png`;

    logger.info('[ComfyUIClient] Uploading image...');
    const uploadedName = await this.uploadImage(imageBuffer, filename);

    logger.info('[ComfyUIClient] Submitting job', { seed, durationSeconds });
    const workflow = this.buildWorkflow(uploadedName, prompt, seed, durationSeconds);
    const promptId = await this.submitPrompt(workflow);

    logger.info('[ComfyUIClient] Waiting for job', { promptId });
    const job = await this.waitForCompletion(promptId);

    logger.info('[ComfyUIClient] Job done, downloading video', { promptId });
    return this.downloadVideo(job);
  }
}
