// Wan2.2 I2V workflow - loads exported API JSON (video_wan2_2_14B_i2v_80GB_adaptive_api.json). Do not build API from workflow.

import { logger } from '@/utils/logger';
import { readFileSync } from 'fs';
import { join } from 'path';

/** FPS for converting durationSeconds to frame count (must match CreateVideo fps in workflow). */
const WORKFLOW_FPS = 16;

/** Default negative prompt (node 89). */
export const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

export type Wan22WorkflowNode = { inputs: Record<string, unknown>; class_type: string };

let cachedRemixApiWorkflow: Record<string, Wan22WorkflowNode> | null = null;

function loadRemixI2VWorkflowTemplate(): Record<string, Wan22WorkflowNode> {
  if (cachedRemixApiWorkflow) return cachedRemixApiWorkflow;

  const workflowPath = join(process.cwd(), 'comfyu', 'workflow', 'opt', 'video_wan2_2_14B_i2v_80GB_adaptive_api.json');
  try {
    const raw = readFileSync(workflowPath, 'utf-8');
    cachedRemixApiWorkflow = JSON.parse(raw) as Record<string, Wan22WorkflowNode>;
    logger.debug('[wan22Workflow] Loaded remix I2V workflow', { path: workflowPath, nodeCount: Object.keys(cachedRemixApiWorkflow).length });
    return cachedRemixApiWorkflow;
  } catch (err) {
    logger.error('[wan22Workflow] Failed to load remix I2V workflow', { path: workflowPath, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export type Wan22RemixBuildOptions = {
  prompt?: string;
  seed?: number;
  durationSeconds?: number;
  negativePrompt?: string;
};

/**
 * Build Wan2.2 I2V Remix workflow from exported API JSON (video_wan2_2_14B_i2v_80GB_adaptive_api.json).
 * User-filled params only (do not change other nodes):
 * - 97 LoadImage: image = uploaded image filename
 * - 93 CLIPTextEncode: text = positive prompt (options.prompt)
 * - 89 CLIPTextEncode: text = negative prompt (options.negativePrompt)
 * - 86 KSamplerAdvanced: noise_seed (options.seed)
 * - 98 WanImageToVideo: length = num_frames (from options.durationSeconds)
 */
export function buildWan22I2VRemixWorkflow(
  uploadedFilename: string,
  options?: Wan22RemixBuildOptions,
): Record<string, Wan22WorkflowNode> {
  const prompt = options?.prompt ?? '';
  const negativePrompt = options?.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT;
  const seed = options?.seed ?? Math.floor(Math.random() * 2 ** 32);
  const durationSeconds = Math.max(1, Math.min(15, options?.durationSeconds ?? 5));
  const numFrames = Math.max(16, Math.min(240, Math.round(durationSeconds * WORKFLOW_FPS)));

  const template = loadRemixI2VWorkflowTemplate();
  const workflow: Record<string, Wan22WorkflowNode> = {};

  for (const [id, node] of Object.entries(template)) {
    const inputs = { ...node.inputs };

    if (node.class_type === 'LoadImage' && id === '97') {
      inputs.image = uploadedFilename;
    }
    if (node.class_type === 'CLIPTextEncode' && id === '93') {
      inputs.text = prompt;
    }
    if (node.class_type === 'CLIPTextEncode' && id === '89') {
      inputs.text = negativePrompt;
    }
    if (node.class_type === 'KSamplerAdvanced' && id === '86') {
      inputs.noise_seed = seed;
    }
    if (node.class_type === 'WanImageToVideo' && id === '98') {
      inputs.length = numFrames;
    }

    workflow[id] = { class_type: node.class_type, inputs };
  }

  return workflow;
}

