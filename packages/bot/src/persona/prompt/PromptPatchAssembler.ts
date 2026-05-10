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

import type { CharacterBible } from '../data/CharacterBibleLoader';
import type { EpigeneticsStore } from '../reflection/epigenetics/EpigeneticsStore';
import type { PersonaEpigenetics, PersonaRelationship } from '../reflection/epigenetics/types';
import { TONE_MAPPINGS } from '../reflection/tone/mappings';
import { isTone } from '../reflection/tone/types';
import type { PersonaStateSnapshot } from '../types';

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
  /** Short Chinese summary of the persona↔user relationship state. Phase 2. */
  relationshipSummary?: string;
  /**
   * Tone-derived prompt fragment from `TONE_MAPPINGS[currentTone].promptFragment`.
   * Undefined when tone is neutral or unknown (no injection needed).
   */
  tonePromptFragment?: string;
  /**
   * Persona identity block built from CharacterBible Self-concept + Voice + Lore.
   * Already truncated per `bibleMaxCharsPerSection`. Empty/undefined when bible is empty
   * or `injectBible` is false. Rendered into a `<persona_identity>` XML block.
   */
  personaIdentity?: string;
  /**
   * Persona hard boundaries block built from CharacterBible Boundaries section.
   * Already truncated. Rendered into a separate `<persona_boundaries>` XML block so the
   * LLM treats anti-jailbreak rules as a distinct directive.
   */
  personaBoundaries?: string;
  // Reserved for later phases (keep them optional + additive):
  // strategyDirective?: string;
  // memoryAnchors?: string[];
  // catchphraseHint?: string;
}

/**
 * Build a PromptPatch from a mind snapshot. Returns an empty object
 * (not null) when nothing is notable — simpler for the caller.
 */
export function buildPromptPatch(
  snapshot: PersonaStateSnapshot,
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
 * non-empty piece in an XML-style block so the LLM sees it as a distinct
 * instruction, not blended into the main persona.
 *
 * Returns an empty string when the patch has no non-empty fields —
 * caller should detect `''` and skip injection (don't push blank
 * fragments to PromptInjectionRegistry).
 *
 * **Note**: kept for back-compat / tests; production reply pipeline now
 * uses `renderStablePromptPatchFragment` + `renderVolatilePromptPatchFragment`
 * separately so stable persona content can sit in the cache-friendly
 * front of the system prompt while volatile mind state stays at the back.
 */
export function renderPromptPatchFragment(patch: PromptPatch): string {
  const stable = renderStablePromptPatchFragment(patch);
  const volatile = renderVolatilePromptPatchFragment(patch);
  return [stable, volatile].filter((s) => s.length > 0).join('\n\n');
}

/**
 * Render only the **stable** persona identity blocks (Bible-derived,
 * doesn't change run-to-run for a given persona):
 *   - `<persona_identity>` — Self-concept + Voice + Lore
 *   - `<persona_boundaries>` — anti-jailbreak / safety baseline
 *
 * These are intended to sit in the cache-friendly **front** of the
 * system prompt, after the equally-stable `base.system.txt` and before
 * the per-message-volatile blocks. Same persona + same Bible → same
 * output → prompt cache hit.
 *
 * Returns empty string when no stable fields are present.
 */
export function renderStablePromptPatchFragment(patch: PromptPatch): string {
  const lines: string[] = [];
  if (patch.personaIdentity) {
    lines.push(`<persona_identity>\n${patch.personaIdentity}\n</persona_identity>`);
  }
  if (patch.personaBoundaries) {
    lines.push(`<persona_boundaries>\n${patch.personaBoundaries}\n</persona_boundaries>`);
  }
  return lines.join('\n\n');
}

/**
 * Render only the **volatile** persona state blocks (recompute every
 * message, change with phenotype / per-user / System-2 reflection):
 *   - `<mind_state>` — fatigue → moodSummary
 *   - `<relationship_state>` — per-user affinity / familiarity summary
 *   - `<tone_state>` — currentTone fragment from reflection
 *
 * These sit at the **back** of the system prompt where their volatility
 * doesn't break upstream cache prefixes.
 *
 * Returns empty string when no volatile fields are present.
 */
export function renderVolatilePromptPatchFragment(patch: PromptPatch): string {
  const lines: string[] = [];
  if (patch.moodSummary) {
    lines.push(`<mind_state>\n${patch.moodSummary}\n</mind_state>`);
  }
  if (patch.relationshipSummary) {
    lines.push(`<relationship_state>\n${patch.relationshipSummary}\n</relationship_state>`);
  }
  if (patch.tonePromptFragment) {
    lines.push(`<tone_state>\n${patch.tonePromptFragment}\n</tone_state>`);
  }
  return lines.join('\n\n');
}

// ─── Relationship summary helpers ────────────────────────────────────────────

/** Map an affinity value to a concise Chinese bucket phrase. */
function affinityBucket(affinity: number): string {
  if (affinity >= 0.5) return '对你非常有好感';
  if (affinity >= 0.1) return '对你略有好感';
  if (affinity > -0.1) return '关系普通';
  if (affinity > -0.5) return '略有隔阂';
  return '较为反感';
}

/** Map a familiarity value to a concise Chinese bucket phrase. */
function familiarityBucket(familiarity: number): string {
  if (familiarity >= 0.7) return '非常熟悉';
  if (familiarity >= 0.4) return '比较熟悉';
  if (familiarity >= 0.15) return '有些了解';
  return '了解不多';
}

/**
 * Build a concise Chinese summary of the persona↔user relationship.
 *
 * Includes visible numeric affinity and familiarity values alongside bucket
 * phrases so the LLM can calibrate response tone precisely.
 *
 * - null (first interaction) → phrase containing `首次`
 * - otherwise → affinity bucket + numeric + familiarity bucket + numeric
 *               + optional tag list + optional epigenetics hints
 */
export function buildRelationshipSummary(
  relationship: PersonaRelationship | null,
  epigenetics?: PersonaEpigenetics | null,
): string {
  if (!relationship) {
    return '这是与该用户的首次互动，保持开放友好的态度。';
  }
  const affinitySign = relationship.affinity >= 0 ? '+' : '';
  const affinityStr = `${affinitySign}${relationship.affinity.toFixed(2)}`;
  const familiarityStr = relationship.familiarity.toFixed(2);
  const affinityPhrase = affinityBucket(relationship.affinity);
  const familiarityPhrase = familiarityBucket(relationship.familiarity);
  let summary = `你${affinityPhrase}（好感度：${affinityStr}），彼此${familiarityPhrase}（熟悉度：${familiarityStr}）。`;
  if (relationship.tags && relationship.tags.length > 0) {
    summary += `用户标签：[${relationship.tags.join(', ')}]`;
  }
  // Incorporate notable behavioral biases from epigenetics (Phase 2).
  // Skip non-numeric entries (e.g. currentTone stored as string).
  if (epigenetics) {
    const biasEntries = Object.entries(epigenetics.behavioralBiases).filter(
      ([, v]) => typeof v === 'number' && Math.abs(v) >= 0.1,
    ) as [string, number][];
    if (biasEntries.length > 0) {
      const biasText = biasEntries.map(([k, v]) => `${k}:${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(', ');
      summary += `行为偏差：${biasText}。`;
    }
    const prefKeys = Object.keys(epigenetics.learnedPreferences);
    if (prefKeys.length > 0) {
      summary += `已知偏好：${prefKeys.slice(0, 3).join('、')}。`;
    }
  }
  return summary;
}

/**
 * Build the inner text for the `<persona_identity>` XML block from a CharacterBible.
 *
 * Combines Self-concept + Voice + Lore in that order, each labeled `[Section]\n...`,
 * separated by a blank line. Each section is truncated to `maxCharsPerSection` chars
 * (counted by `String.length`, treating each Unicode code unit as 1 — fine for the
 * Chinese/English mix used in this project; this is a budget heuristic, not a token
 * count). Truncated sections get a trailing ` …` (single space + `…`).
 *
 * Empty source sections are skipped entirely (no header emitted). Returns `''` when all
 * three are empty so callers can short-circuit.
 */
export function buildPersonaIdentityFragment(bible: CharacterBible, maxCharsPerSection: number): string {
  const parts: string[] = [];
  if (bible.selfConcept) parts.push(`[Self-concept]\n${truncateChars(bible.selfConcept, maxCharsPerSection)}`);
  if (bible.voice) parts.push(`[Voice]\n${truncateChars(bible.voice, maxCharsPerSection)}`);
  if (bible.lore) parts.push(`[Lore]\n${truncateChars(bible.lore, maxCharsPerSection)}`);
  return parts.join('\n\n');
}

/**
 * Build the inner text for the `<persona_boundaries>` XML block — truncated Boundaries
 * section. Returns `''` for an empty bible (caller skips the block).
 */
export function buildPersonaBoundariesFragment(bible: CharacterBible, maxChars: number): string {
  if (!bible.boundaries) return '';
  return truncateChars(bible.boundaries, maxChars);
}

/** Local helper — pure char-count truncation. Not exported. */
function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)} …`;
}

/**
 * Async variant of `buildPromptPatch` that additionally populates
 * `relationshipSummary` from the EpigeneticsStore when available.
 *
 * Falls back gracefully: if store/personaId/userId is absent, the
 * relationship field is simply omitted (same as before Phase 2).
 */
export async function buildPromptPatchAsync(
  snapshot: PersonaStateSnapshot,
  opts: {
    store?: EpigeneticsStore | null;
    userId?: string | null;
    thresholds?: PromptPatchThresholds;
    bible?: CharacterBible | null;
    injectBible?: boolean;
    bibleMaxCharsPerSection?: number;
  } = {},
): Promise<PromptPatch> {
  const patch = buildPromptPatch(snapshot, opts.thresholds);
  if (!snapshot.enabled) return patch;
  // Bible injection is independent of epigenetics store — apply it before the store guard.
  if (opts.injectBible && opts.bible) {
    const maxChars = opts.bibleMaxCharsPerSection ?? 800;
    const identity = buildPersonaIdentityFragment(opts.bible, maxChars);
    if (identity) patch.personaIdentity = identity;
    const boundaries = buildPersonaBoundariesFragment(opts.bible, maxChars);
    if (boundaries) patch.personaBoundaries = boundaries;
  }
  if (!opts.store || !opts.userId) return patch;
  try {
    // Read relationship + epigenetics in parallel for relationship summary and tone.
    const [relationship, epigenetics] = await Promise.all([
      opts.store.getRelationship(snapshot.personaId, opts.userId),
      opts.store.getEpigenetics(snapshot.personaId),
    ]);
    patch.relationshipSummary = buildRelationshipSummary(relationship, epigenetics);
    // Attach tone fragment if a valid non-neutral tone is recorded in epigenetics.
    if (epigenetics) {
      const rawTone = epigenetics.behavioralBiases['currentTone'];
      const tone = isTone(rawTone) ? rawTone : 'neutral';
      const fragment = TONE_MAPPINGS[tone].promptFragment;
      if (fragment) {
        patch.tonePromptFragment = fragment;
      }
    }
  } catch {
    // Non-fatal: leave relationshipSummary and tonePromptFragment unset
  }
  return patch;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
