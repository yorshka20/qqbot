/**
 * Zod schemas for LLM image prompt JSON output (I2V, T2I params, additional params).
 * Used by ImagePromptService.
 */

import { z } from 'zod';
import type { Text2ImageOptions } from '../capabilities/types';

export interface I2VPromptResult {
  prompt: string;
  durationSeconds: number;
  negativePrompt?: string;
}

const DEFAULT_I2V_DURATION_SECONDS = 5;
const MIN_I2V_DURATION_SECONDS = 1;
const MAX_I2V_DURATION_SECONDS = 30;

const MAX_STEPS = 50;
const MAX_GUIDANCE_SCALE = 9;
const DEFAULT_STEPS = 45;
const DEFAULT_GUIDANCE_SCALE = 7;
const DEFAULT_WIDTH = 832;
const DEFAULT_HEIGHT = 1216;

function clampNum(v: unknown, defaultVal: number, min: number, max: number): number {
  const n = typeof v === 'number' && !Number.isNaN(v) ? v : typeof v === 'string' ? parseFloat(v) : Number.NaN;
  if (Number.isNaN(n)) {
    return defaultVal;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

export const I2VPromptResultSchema = z
  .object({
    prompt: z.string().min(1).trim(),
    duration_seconds: z
      .unknown()
      .optional()
      .transform((v) => clampNum(v, DEFAULT_I2V_DURATION_SECONDS, MIN_I2V_DURATION_SECONDS, MAX_I2V_DURATION_SECONDS)),
    negative_prompt: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
  })
  .transform(
    (o): I2VPromptResult => ({
      prompt: o.prompt,
      durationSeconds: o.duration_seconds ?? DEFAULT_I2V_DURATION_SECONDS,
      negativePrompt: o.negative_prompt,
    }),
  );

export const T2IImageParamsSchema = z
  .object({
    prompt: z.string().min(1).trim(),
    negative_prompt: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'string' ? v : '')),
    steps: z
      .unknown()
      .optional()
      .transform((v) => clampNum(v, DEFAULT_STEPS, 1, MAX_STEPS)),
    cfg_scale: z
      .unknown()
      .optional()
      .transform((v) => clampNum(v, DEFAULT_GUIDANCE_SCALE, 1, MAX_GUIDANCE_SCALE)),
    seed: z
      .unknown()
      .optional()
      .transform((v) => clampNum(v, -1, -1, Number.MAX_SAFE_INTEGER)),
    width: z
      .unknown()
      .optional()
      .transform((v) => clampNum(v, DEFAULT_WIDTH, 256, 2048)),
    height: z
      .unknown()
      .optional()
      .transform((v) => clampNum(v, DEFAULT_HEIGHT, 256, 2048)),
    sampler: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'string' && v.trim() ? v : 'Euler a')),
  })
  .transform(
    (o): Text2ImageOptions => ({
      prompt: o.prompt,
      negative_prompt: o.negative_prompt ?? '',
      steps: o.steps ?? DEFAULT_STEPS,
      cfg_scale: o.cfg_scale ?? DEFAULT_GUIDANCE_SCALE,
      seed: o.seed ?? -1,
      width: o.width ?? DEFAULT_WIDTH,
      height: o.height ?? DEFAULT_HEIGHT,
      sampler: o.sampler ?? 'Euler a',
    }),
  );

export const AdditionalParamsSchema = z
  .object({
    aspectRatio: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'string' && v.trim() ? v : undefined)),
    resolution: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : undefined)),
    imageSize: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : undefined)),
  })
  .transform((o): Partial<Text2ImageOptions> => {
    const out: Partial<Text2ImageOptions> = {};
    if (o.aspectRatio) {
      out.aspectRatio = o.aspectRatio;
    }
    const imageSize = o.imageSize ?? o.resolution;
    if (imageSize) {
      out.imageSize = imageSize;
    }
    return out;
  });
