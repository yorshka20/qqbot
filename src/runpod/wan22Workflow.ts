// Wan2.2 I2V workflow - loads remix workflow from comfyu/workflow/wan22_remix_i2v.json,
// converts UI format to API format, and applies parameter overrides (image, prompt, seed, duration).

import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '@/utils/logger';

/** FPS in workflow CreateVideo node; used to convert durationSeconds to frame count. */
const WORKFLOW_FPS = 16;

export type Wan22WorkflowNode = { inputs: Record<string, unknown>; class_type: string };

/** ComfyUI UI workflow format (nodes + links) */
interface UiNode {
  id: number;
  type: string;
  inputs?: Array<{ name: string; type?: string; link: number | null }>;
  widgets_values?: unknown[];
}

interface UiWorkflow {
  nodes: UiNode[];
  links: Array<[number, number, number, number, number, string]>;
}

/** Widget input names per node type (order matches widgets_values). Skip types that have no widgets or we don't need. */
const WIDGET_INPUT_NAMES: Record<string, string[]> = {
  CLIPLoader: ['clip_name', 'type', 'device'],
  LoadImage: ['image'],
  CLIPTextEncode: ['text'],
  WanImageToVideo: ['width', 'height', 'length', 'batch_size'],
  KSamplerAdvanced: [
    'add_noise',
    'noise_seed',
    'noise_opt',
    'steps',
    'cfg',
    'sampler_name',
    'scheduler',
    'start_at_step',
    'end_at_step',
    'return_with_leftover_noise',
  ],
  CreateVideo: ['fps'],
  SaveVideo: ['filename_prefix', 'format', 'codec'],
  VAELoader: ['vae_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  ModelSamplingSD3: ['shift'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
};

const SKIP_NODE_TYPES = new Set(['Note', 'MarkdownNote']);

/**
 * Convert ComfyUI UI workflow (nodes + links) to API format (node_id -> { class_type, inputs }).
 */
function convertUiWorkflowToApi(ui: UiWorkflow): Record<string, Wan22WorkflowNode> {
  const linkIdToOrigin: Record<number, [string, number]> = {};
  for (const link of ui.links) {
    const [linkId, oNode, oSlot, , ,] = link;
    linkIdToOrigin[linkId] = [String(oNode), oSlot];
  }

  const api: Record<string, Wan22WorkflowNode> = {};
  for (const node of ui.nodes) {
    if (SKIP_NODE_TYPES.has(node.type)) continue;

    const inputs: Record<string, unknown> = {};

    // Linked inputs
    const nodeInputs = node.inputs ?? [];
    for (let i = 0; i < nodeInputs.length; i++) {
      const inp = nodeInputs[i];
      if (inp.link != null) {
        const origin = linkIdToOrigin[inp.link];
        if (origin) inputs[inp.name] = origin;
      }
    }

    // Widget values
    const widgetNames = WIDGET_INPUT_NAMES[node.type];
    const values = node.widgets_values ?? [];
    if (widgetNames) {
      for (let i = 0; i < widgetNames.length && i < values.length; i++) {
        inputs[widgetNames[i]] = values[i];
      }
    }

    api[String(node.id)] = { class_type: node.type, inputs };
  }
  return api;
}

let cachedApiWorkflow: Record<string, Wan22WorkflowNode> | null = null;

function loadRemixWorkflowTemplate(): Record<string, Wan22WorkflowNode> {
  if (cachedApiWorkflow) return cachedApiWorkflow;

  const workflowPath = join(process.cwd(), 'comfyu', 'workflow', 'wan22_remix_i2v.json');
  try {
    const raw = readFileSync(workflowPath, 'utf-8');
    const ui = JSON.parse(raw) as UiWorkflow;
    if (!ui.nodes || !ui.links) {
      throw new Error('Invalid workflow: missing nodes or links');
    }
    cachedApiWorkflow = convertUiWorkflowToApi(ui);
    logger.debug('[wan22Workflow] Loaded remix workflow', { path: workflowPath, nodeCount: Object.keys(cachedApiWorkflow).length });
    return cachedApiWorkflow;
  } catch (err) {
    logger.error('[wan22Workflow] Failed to load remix workflow', { path: workflowPath, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Build Wan2.2 I2V workflow from remix template with parameterized prompt, image filename, seed, and duration.
 * durationSeconds: 1–15, default 5; converted to frame count (length) for WanImageToVideo node.
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

    // LoadImage (97): image filename
    if (node.class_type === 'LoadImage') {
      inputs.image = uploadedFilename;
    }
    // CLIPTextEncode positive prompt (93)
    if (node.class_type === 'CLIPTextEncode' && id === '93') {
      inputs.text = positivePrompt;
    }
    // WanImageToVideo (98): length in frames
    if (node.class_type === 'WanImageToVideo') {
      inputs.length = lengthFrames;
    }
    // KSamplerAdvanced with add_noise "enable" (86): noise_seed
    if (node.class_type === 'KSamplerAdvanced' && inputs.add_noise === 'enable') {
      inputs.noise_seed = seed;
    }

    workflow[id] = { class_type: node.class_type, inputs };
  }

  return workflow;
}
