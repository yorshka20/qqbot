// Wan2.2 I2V workflow - supports two API JSONs: optimized remix and adaptive. Do not build API from workflow.

import { logger } from '@/utils/logger';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Default negative prompt (shared). */
export const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

export type Wan22WorkflowNode = { inputs: Record<string, unknown>; class_type: string };

export type Wan22RemixBuildOptions = {
  prompt?: string;
  seed?: number;
  durationSeconds?: number;
  negativePrompt?: string;
};

// ---------------------------------------------------------------------------
// Optimized Remix API (wan22-i2v-remix-nsfw-optimized-api.json)
// ---------------------------------------------------------------------------

const WORKFLOW_FPS_OPTIMIZED = 32;

let cachedRemixOptimizedApiWorkflow: Record<string, Wan22WorkflowNode> | null = null;

function loadRemixOptimizedTemplate(): Record<string, Wan22WorkflowNode> {
  if (cachedRemixOptimizedApiWorkflow) return cachedRemixOptimizedApiWorkflow;

  const workflowPath = join(process.cwd(), 'comfyu', 'opt', 'wan22-i2v-remix-nsfw-optimized-api.json');
  try {
    const raw = readFileSync(workflowPath, 'utf-8');
    cachedRemixOptimizedApiWorkflow = JSON.parse(raw) as Record<string, Wan22WorkflowNode>;
    logger.debug('[wan22Workflow] Loaded remix optimized I2V workflow', { path: workflowPath, nodeCount: Object.keys(cachedRemixOptimizedApiWorkflow).length });
    return cachedRemixOptimizedApiWorkflow;
  } catch (err) {
    logger.error('[wan22Workflow] Failed to load remix optimized I2V workflow', { path: workflowPath, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Build Wan2.2 I2V Remix workflow from wan22-i2v-remix-nsfw-optimized-api.json.
 * Nodes: 148 LoadImage, 134/137 CLIPTextEncode, 139/140 WanVideoSampler, 156 WanVideoImageToVideoEncode. FPS 32.
 */
export function buildWan22I2VRemixWorkflowOptimized(
  uploadedFilename: string,
  options?: Wan22RemixBuildOptions,
): Record<string, Wan22WorkflowNode> {
  const prompt = options?.prompt ?? '';
  const negativePrompt = options?.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT;
  const seed = options?.seed ?? Math.floor(Math.random() * 2 ** 32);
  const durationSeconds = Math.max(1, Math.min(15, options?.durationSeconds ?? 5));
  const numFrames = Math.max(16, Math.min(240, Math.round(durationSeconds * WORKFLOW_FPS_OPTIMIZED)));

  const template = loadRemixOptimizedTemplate();
  const workflow: Record<string, Wan22WorkflowNode> = {};

  for (const [id, node] of Object.entries(template)) {
    const inputs = { ...node.inputs };

    if (node.class_type === 'LoadImage' && id === '148') {
      inputs.image = uploadedFilename;
    }
    if (node.class_type === 'CLIPTextEncode' && id === '134') {
      inputs.text = prompt;
    }
    if (node.class_type === 'CLIPTextEncode' && id === '137') {
      inputs.text = negativePrompt;
    }
    if (node.class_type === 'WanVideoSampler' && (id === '139' || id === '140')) {
      inputs.seed = seed;
    }
    if (node.class_type === 'WanVideoImageToVideoEncode' && id === '156') {
      inputs.num_frames = numFrames;
    }

    workflow[id] = { class_type: node.class_type, inputs };
  }

  return workflow;
}

// ---------------------------------------------------------------------------
// Adaptive API (video_wan2_2_14B_i2v_80GB_adaptive_api.json)
// ---------------------------------------------------------------------------

const WORKFLOW_FPS_ADAPTIVE = 16;

let cachedAdaptiveApiWorkflow: Record<string, Wan22WorkflowNode> | null = null;

function loadAdaptiveTemplate(): Record<string, Wan22WorkflowNode> {
  if (cachedAdaptiveApiWorkflow) return cachedAdaptiveApiWorkflow;

  const workflowPath = join(process.cwd(), 'comfyu', 'workflow', 'origin', 'video_wan2_2_14B_i2v_80GB_adaptive_api.json');
  try {
    const raw = readFileSync(workflowPath, 'utf-8');
    cachedAdaptiveApiWorkflow = JSON.parse(raw) as Record<string, Wan22WorkflowNode>;
    logger.debug('[wan22Workflow] Loaded adaptive I2V workflow', { path: workflowPath, nodeCount: Object.keys(cachedAdaptiveApiWorkflow).length });
    return cachedAdaptiveApiWorkflow;
  } catch (err) {
    logger.error('[wan22Workflow] Failed to load adaptive I2V workflow', { path: workflowPath, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Build Wan2.2 I2V workflow from video_wan2_2_14B_i2v_80GB_adaptive_api.json.
 * Nodes: 97 LoadImage, 93/89 CLIPTextEncode, 86 KSamplerAdvanced, 98 WanImageToVideo. FPS 16.
 */
export function buildWan22I2VRemixWorkflowOrigin(
  uploadedFilename: string,
  options?: Wan22RemixBuildOptions,
): Record<string, Wan22WorkflowNode> {
  const prompt = options?.prompt ?? '';
  const negativePrompt = options?.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT;
  const seed = options?.seed ?? Math.floor(Math.random() * 2 ** 32);
  const durationSeconds = Math.max(1, Math.min(15, options?.durationSeconds ?? 5));
  const numFrames = Math.max(16, Math.min(240, Math.round(durationSeconds * WORKFLOW_FPS_ADAPTIVE)));

  const template = loadAdaptiveTemplate();
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

// ---------------------------------------------------------------------------
// Current variant: switch to choose which workflow API is used by default
// ---------------------------------------------------------------------------

export type Wan22RemixWorkflowVariant = 'optimized' | 'origin';

/** Set to 'optimized' to use new remix (wan22-i2v-remix-nsfw-optimized-api.json), 'origin' for original API. */
export const WAN22_REMIX_WORKFLOW_VARIANT: Wan22RemixWorkflowVariant = 'optimized';

/**
 * Build Wan2.2 I2V Remix workflow using the current variant (see WAN22_REMIX_WORKFLOW_VARIANT).
 * Default is 'optimized' (new remix).
 */
export function buildWan22I2VRemixWorkflow(
  uploadedFilename: string,
  options?: Wan22RemixBuildOptions,
): Record<string, Wan22WorkflowNode> {
  if (WAN22_REMIX_WORKFLOW_VARIANT === 'origin') {
    return buildWan22I2VRemixWorkflowOrigin(uploadedFilename, options);
  }
  return buildWan22I2VRemixWorkflowOptimized(uploadedFilename, options);
}
