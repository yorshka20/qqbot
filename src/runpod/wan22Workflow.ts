// Wan2.2 I2V workflow - loads API-format workflow, applies minimal parameter overrides.
// Supports: wan22_remix_i2v_api.json (old), wan22_i2v_remix_api.json (new WanVideoWrapper).

import { logger } from '@/utils/logger';
import { readFileSync } from 'fs';
import { join } from 'path';

/** FPS for converting durationSeconds to frame count. */
const WORKFLOW_FPS = 16;

/** Default negative prompt for Wan22-I2V-Remix workflow (node 137). */
export const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

export type Wan22WorkflowNode = { inputs: Record<string, unknown>; class_type: string };

let cachedApiWorkflow: Record<string, Wan22WorkflowNode> | null = null;
let cachedRemixApiWorkflow: Record<string, Wan22WorkflowNode> | null = null;

function loadRemixWorkflowTemplate(): Record<string, Wan22WorkflowNode> {
  if (cachedApiWorkflow) return cachedApiWorkflow;

  const workflowPath = join(process.cwd(), 'comfyu', 'workflow', 'wan22_remix_i2v_api.json');
  try {
    const raw = readFileSync(workflowPath, 'utf-8');
    cachedApiWorkflow = JSON.parse(raw) as Record<string, Wan22WorkflowNode>;
    logger.debug('[wan22Workflow] Loaded remix workflow', { path: workflowPath, nodeCount: Object.keys(cachedApiWorkflow).length });
    return cachedApiWorkflow;
  } catch (err) {
    logger.error('[wan22Workflow] Failed to load remix workflow', { path: workflowPath, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function loadRemixI2VWorkflowTemplate(): Record<string, Wan22WorkflowNode> {
  if (cachedRemixApiWorkflow) return cachedRemixApiWorkflow;

  const workflowPath = join(process.cwd(), 'comfyu', 'workflow', 'wan22_i2v_remix_api.json');
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

/**
 * Build Wan2.2 I2V Remix workflow (WanVideoWrapper) from template.
 * Modifies: LoadImage id=148 (image), CLIPTextEncode id=134 (positive), id=137 (negative),
 * WanVideoImageToVideoEncode id=156 (length), WanVideoSampler id=139 (seed).
 */
export function buildWan22I2VRemixWorkflow(
  uploadedFilename: string,
  positivePrompt: string,
  seed: number,
  durationSeconds: number = 5,
  options?: { negativePrompt?: string },
): Record<string, Wan22WorkflowNode> {
  const lengthFrames = Math.max(16, Math.min(240, Math.round(durationSeconds * WORKFLOW_FPS)));
  const negativePrompt = options?.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT;

  const template = loadRemixI2VWorkflowTemplate();
  const workflow: Record<string, Wan22WorkflowNode> = {};

  for (const [id, node] of Object.entries(template)) {
    const inputs = { ...node.inputs };

    if (node.class_type === 'LoadImage' && id === '148') {
      inputs.image = uploadedFilename;
    }
    if (node.class_type === 'CLIPTextEncode' && id === '134') {
      inputs.text = positivePrompt;
    }
    if (node.class_type === 'CLIPTextEncode' && id === '137') {
      inputs.text = negativePrompt;
    }
    if (node.class_type === 'WanVideoImageToVideoEncode' && id === '156') {
      inputs.num_frames = lengthFrames;
    }
    // WanVideoSampler id=139 has noise_opt "randomize" - it uses the user seed
    if (node.class_type === 'WanVideoSampler' && id === '139') {
      inputs.seed = seed;
    }

    workflow[id] = { class_type: node.class_type, inputs };
  }

  return workflow;
}

/**
 * Build Wan2.2 I2V workflow from remix template with parameterized prompt, image filename, seed, and duration.
 * Only modifies: LoadImage (image), CLIPTextEncode id=93 (text), WanImageToVideo (length), KSamplerAdvanced (noise_seed where add_noise=enable).
 * All other nodes (UNETLoader, CLIPLoader, VAELoader, LoraLoaderModelOnly) are left unchanged to preserve NSFW models and LoRA.
 */
export function buildWan22I2VWorkflow(
  uploadedFilename: string,
  positivePrompt: string,
  seed: number,
  durationSeconds: number = 5,
): Record<string, Wan22WorkflowNode> {
  const lengthFrames = Math.max(
    16,
    Math.min(240, Math.round(durationSeconds * WORKFLOW_FPS)),
  );

  const template = loadRemixWorkflowTemplate();
  const workflow: Record<string, Wan22WorkflowNode> = {};

  for (const [id, node] of Object.entries(template)) {
    const inputs = { ...node.inputs };

    // LoadImage: replace image with uploaded filename
    if (node.class_type === 'LoadImage') {
      inputs.image = uploadedFilename;
    }
    // CLIPTextEncode id=93 (positive prompt): replace text
    if (node.class_type === 'CLIPTextEncode' && id === '93') {
      inputs.text = positivePrompt;
    }
    // WanImageToVideo: replace length with frame count
    if (node.class_type === 'WanImageToVideo') {
      inputs.length = lengthFrames;
    }
    // KSamplerAdvanced with add_noise=enable: replace noise_seed
    if (node.class_type === 'KSamplerAdvanced' && inputs.add_noise === 'enable') {
      inputs.noise_seed = seed;
    }

    workflow[id] = { class_type: node.class_type, inputs };
  }

  // Debug: log model nodes to verify UNETLoader, CLIPLoader, VAELoader, LoraLoaderModelOnly are correct
  for (const [nid, n] of Object.entries(workflow)) {
    if (['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoaderModelOnly'].includes(n.class_type)) {
      logger.debug('[wan22Workflow] Model node', { id: nid, class_type: n.class_type, inputs: n.inputs });
    }
  }

  return workflow;
}
