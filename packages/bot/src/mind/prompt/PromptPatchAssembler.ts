/**
 * PromptPatchAssembler — turns the mind phenotype into short Chinese
 * snippets that get injected into the reply pipeline's system prompt.
 *
 * Phase 2 only produces a `moodSummary` derived from `fatigue` (the only
 * reliably-observable axis in Phase 1). Later phases add relationship
 * summary, strategy directive, memory anchors, catchphrase hints.
 *
 * The function is pure and deterministic — same input always produces
 * the same output. Variation / thresholding belongs in the translator,
 * not in random selection, so prompt caches downstream still hit.
 *
 * Design principles:
 *  - **Stay silent when unremarkable.** Below `fatigueMildMin` the patch
 *    is empty and nothing is injected. This prevents a monotone "你现在
 *    有点累" attached to every single reply when fatigue is noise-level.
 *  - **Never leak numbers.** LLM doesn't need to see "fatigue=0.62"; it
 *    just needs the human-friendly summary.
 *  - **Short & imperative.** Each summary is one sentence, ≤ 60 Chinese
 *    chars, tells the LLM *how to color the reply* rather than stating
 *    bot state as fact.
 */

import type { MindStateSnapshot } from '../types';

/** Thresholds that decide which bucket fatigue falls into. */
export interface PromptPatchThresholds {
  /** Below this, fatigue is considered background noise — no mood patch emitted. */
  fatigueMildMin: number;
  /** Between mild and moderate, inject a light倦意 hint. */
  fatigueModerateMin: number;
  /** Above severe, inject the strongest撑不住 hint. */
  fatigueSevereMin: number;
}

export const DEFAULT_PROMPT_PATCH_THRESHOLDS: PromptPatchThresholds = {
  fatigueMildMin: 0.3,
  fatigueModerateMin: 0.55,
  fatigueSevereMin: 0.8,
};

/**
 * Structured patch — each field is a short natural-language fragment or
 * undefined. Consumers (plugin) render by concatenating non-empty fields.
 */
export interface PromptPatch {
  moodSummary?: string;
  // Reserved for later phases (keep them optional + additive):
  // relationshipSummary?: string;
  // strategyDirective?: string;
  // memoryAnchors?: string[];
  // catchphraseHint?: string;
}

/**
 * Build a PromptPatch from a mind snapshot. Returns an empty object
 * (not null) when nothing is notable — simpler for the caller.
 */
export function buildPromptPatch(
  snapshot: MindStateSnapshot,
  thresholds: PromptPatchThresholds = DEFAULT_PROMPT_PATCH_THRESHOLDS,
): PromptPatch {
  const patch: PromptPatch = {};
  if (!snapshot.enabled) return patch;

  const fatigue = clamp01(snapshot.phenotype.fatigue);

  if (fatigue >= thresholds.fatigueSevereMin) {
    patch.moodSummary = '你此刻非常疲惫，语气可以带上撑不住的感觉，回复尽量简短随意。';
  } else if (fatigue >= thresholds.fatigueModerateMin) {
    patch.moodSummary = '你此刻有些疲倦，语气可以稍显慵懒，回复可以比平常短一点。';
  } else if (fatigue >= thresholds.fatigueMildMin) {
    patch.moodSummary = '你此刻略有些累，可以在回复里透出一点点倦意。';
  }

  return patch;
}

/**
 * Render a PromptPatch into the final prompt fragment string. Wraps each
 * non-empty piece in an XML-style `<mind_state>` block so the LLM sees
 * it as a distinct instruction, not blended into the main persona.
 *
 * Returns an empty string when the patch has no non-empty fields —
 * caller should detect `''` and skip injection (don't push blank
 * fragments to `systemPromptFragments`).
 */
export function renderPromptPatchFragment(patch: PromptPatch): string {
  const lines: string[] = [];
  if (patch.moodSummary) {
    lines.push(`<mind_state>\n${patch.moodSummary}\n</mind_state>`);
  }
  return lines.join('\n\n');
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
