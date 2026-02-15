/**
 * One-time script to convert ComfyUI UI workflow to API format.
 * Run: bun run scripts/convert-workflow-to-api.ts [workflow_name]
 * workflow_name: "wan22_remix_i2v" (default) | "wan22_i2v_remix"
 * Output: comfyu/workflow/{name}_api.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// WIDGET_INPUT_NAMES for wan22_remix_i2v (old workflow)
const WIDGET_NAMES_REMIX: Record<string, string[]> = {
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
  VAEDecode: [],
};

// WIDGET_INPUT_NAMES for Wan22-I2V-Remix (new WanVideoWrapper workflow)
const WIDGET_NAMES_I2V_REMIX: Record<string, string[]> = {
  WanVideoTorchCompileSettings: ['backend', 'fullgraph', 'dynamic', 'options', 'disable_cudnn', 'triton_cache', 'num_workers', 'num_compile_warmup', 'compile_sync'],
  WanVideoBlockSwap: ['swap_threshold', 'swap_layers', 'swap_attention', 'swap_ff', 'swap_min_layers', 'swap_max_layers', 'verbose'],
  CreateVideo: ['fps'],
  SaveVideo: ['filename_prefix', 'format', 'codec'],
  INTConstant: ['value'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  CLIPTextEncode: ['text'],
  WanVideoModelLoader: ['ckpt_name', 'weight_dtype', 'compile_mode', 'vram_management', 'attn_mode', 'compile_backend'],
  WanVideoLoraSelect: ['lora_name', 'strength', 'strength_model', 'blocks'],
  WanVideoSampler: ['start_step', 'cfg', 'steps', 'seed', 'noise_opt', 'add_noise', 'sampler', 'scheduler', 'denoise', 'return_with_leftover', 'compile_backend', 'loop_start', 'loop_end', 'loop_opt'],
  WanVideoTextEmbedBridge: [],
  WanVideoVAELoader: ['vae_name', 'weight_dtype'],
  WanVideoImageToVideoEncode: ['width', 'height', 'length', 'frame_offset', 'batch_size', 'batch_offset', 'use_control', 'use_end_image', 'use_temporal_mask'],
  WanVideoDecode: [],
  GetImageSize: [],
  'MathExpression|pysssss': ['expression'],
  'easy int': ['value'],
  LoadImage: ['image'],
  'RIFE VFI': ['ckpt_name', 'multiplier', 'scale', 'fast_mode', 'ensemble', 'clear_cache_after_n_frames'],
};

const SKIP_NODE_TYPES = new Set(['Note', 'MarkdownNote']);

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

interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

function convertUiWorkflowToApi(ui: UiWorkflow, widgetNames: Record<string, string[]>): Record<string, ApiNode> {
  const linkIdToOrigin: Record<number, [string, number]> = {};
  for (const link of ui.links) {
    const [linkId, oNode, oSlot] = link;
    linkIdToOrigin[linkId] = [String(oNode), oSlot];
  }

  const api: Record<string, ApiNode> = {};
  for (const node of ui.nodes) {
    if (SKIP_NODE_TYPES.has(node.type)) continue;

    const inputs: Record<string, unknown> = {};

    // Linked inputs
    const nodeInputs = node.inputs ?? [];
    for (const inp of nodeInputs) {
      if (inp.link != null) {
        const origin = linkIdToOrigin[inp.link];
        if (origin) inputs[inp.name] = origin;
      }
    }

    // Widget values
    const names = widgetNames[node.type];
    const values = node.widgets_values ?? [];
    if (names?.length) {
      for (let i = 0; i < names.length && i < values.length; i++) {
        inputs[names[i]] = values[i];
      }
    }

    api[String(node.id)] = { class_type: node.type, inputs };
  }
  return api;
}

const workflowName = process.argv[2] ?? 'wan22_remix_i2v';

const configs: Record<string, { uiFile: string; apiFile: string; widgetNames: Record<string, string[]> }> = {
  wan22_remix_i2v: {
    uiFile: 'wan22_remix_i2v.json',
    apiFile: 'wan22_remix_i2v_api.json',
    widgetNames: WIDGET_NAMES_REMIX,
  },
  wan22_i2v_remix: {
    uiFile: 'Wan22-I2V-Remix.json',
    apiFile: 'wan22_i2v_remix_api.json',
    widgetNames: WIDGET_NAMES_I2V_REMIX,
  },
};

const config = configs[workflowName];
if (!config) {
  console.error(`Unknown workflow: ${workflowName}. Use: wan22_remix_i2v | wan22_i2v_remix`);
  process.exit(1);
}

const uiPath = join(process.cwd(), 'comfyu', 'workflow', config.uiFile);
const apiPath = join(process.cwd(), 'comfyu', 'workflow', config.apiFile);

const raw = readFileSync(uiPath, 'utf-8');
const ui = JSON.parse(raw) as UiWorkflow;
if (!ui.nodes || !ui.links) {
  throw new Error('Invalid workflow: missing nodes or links');
}

const api = convertUiWorkflowToApi(ui, config.widgetNames);
writeFileSync(apiPath, JSON.stringify(api, null, 2), 'utf-8');
console.log(`Wrote ${apiPath} (${Object.keys(api).length} nodes)`);
