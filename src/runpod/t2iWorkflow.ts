// T2I workflow - load ComfyUI API-format txt2img template and build workflow with prompt/seed/size/steps/cfg.

import { logger } from '@/utils/logger';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Workflow node shape (same as RunPod input.workflow entries). */
export type T2IWorkflowNode = { inputs: Record<string, unknown>; class_type: string };

/** Options for building T2I workflow (aligned with Text2ImageOptions where relevant). */
export type T2IBuildOptions = {
  prompt?: string;
  negative_prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  guidance_scale?: number;
  cfg_scale?: number;
};

/** Default negative prompt for T2I. */
const DEFAULT_NEGATIVE_PROMPT =
  'bad hands, lowres, bad anatomy, worst quality, low quality, blurry, jpeg artifacts, ugly, duplicate, morbid, mutilated, extra limbs, poorly drawn hands, poorly drawn face, mutation, deformed';

// Node IDs in comfyu/workflow/t2i/sdxl-txt2img-api.json
const NODE_KSAMPLER = '3';
const NODE_EMPTY_LATENT = '5';
const NODE_CLIP_POSITIVE = '6';
const NODE_CLIP_NEGATIVE = '7';

const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 512;
const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 7.5;

let cachedT2ITemplate: Record<string, T2IWorkflowNode> | null = null;

function loadT2ITemplate(): Record<string, T2IWorkflowNode> {
  if (cachedT2ITemplate) return cachedT2ITemplate;

  const workflowPath = join(process.cwd(), 'comfyu', 'workflow', 't2i', 'sdxl-txt2img-api.json');
  try {
    const raw = readFileSync(workflowPath, 'utf-8');
    cachedT2ITemplate = JSON.parse(raw) as Record<string, T2IWorkflowNode>;
    logger.debug('[t2iWorkflow] Loaded T2I workflow', {
      path: workflowPath,
      nodeCount: Object.keys(cachedT2ITemplate).length,
    });
    return cachedT2ITemplate;
  } catch (err) {
    logger.error('[t2iWorkflow] Failed to load T2I workflow', {
      path: workflowPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Build T2I workflow from sdxl-txt2img-api.json template.
 * Injects prompt, negative_prompt, seed, width, height, steps, cfg into the known node IDs.
 */
export function buildT2IWorkflow(options?: T2IBuildOptions): Record<string, T2IWorkflowNode> {
  const prompt = options?.prompt ?? '';
  const negativePrompt = options?.negative_prompt ?? DEFAULT_NEGATIVE_PROMPT;
  const seed = options?.seed ?? Math.floor(Math.random() * 2 ** 32);
  const width = Math.max(64, Math.min(2048, options?.width ?? DEFAULT_WIDTH));
  const height = Math.max(64, Math.min(2048, options?.height ?? DEFAULT_HEIGHT));
  const steps = Math.max(1, Math.min(150, options?.steps ?? DEFAULT_STEPS));
  const cfg = options?.cfg_scale ?? options?.guidance_scale ?? DEFAULT_CFG;

  const template = loadT2ITemplate();
  const workflow: Record<string, T2IWorkflowNode> = {};

  for (const [id, node] of Object.entries(template)) {
    const inputs = { ...node.inputs };

    if (id === NODE_CLIP_POSITIVE && node.class_type === 'CLIPTextEncode') {
      inputs.text = prompt;
    }
    if (id === NODE_CLIP_NEGATIVE && node.class_type === 'CLIPTextEncode') {
      inputs.text = negativePrompt;
    }
    if (id === NODE_EMPTY_LATENT && node.class_type === 'EmptyLatentImage') {
      inputs.width = width;
      inputs.height = height;
    }
    if (id === NODE_KSAMPLER && node.class_type === 'KSampler') {
      inputs.seed = seed;
      inputs.steps = steps;
      inputs.cfg = cfg;
    }

    workflow[id] = { class_type: node.class_type, inputs };
  }

  return workflow;
}
