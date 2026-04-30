// Tone vocabulary and mapping types for Mind Phase 3 (ReflectionEngine).

/** Authoritative list of all valid tone values. Order is stable. */
export const TONE_VOCABULARY = [
  'neutral',
  'playful',
  'sarcastic',
  'affectionate',
  'tsundere',
  'melancholy',
  'excited',
  'weary',
  'professional',
  'dismissive',
  'coy',
  'defiant',
] as const;

/** Union of all valid tone strings. */
export type Tone = (typeof TONE_VOCABULARY)[number];

/**
 * Avatar modulation adjustments that a tone applies on top of the
 * phenotype-derived values from `deriveModulation()`.
 *
 * All scale fields are *multiplicative* around 1.0 (identity).
 * `durationBias` is additive (ms).
 */
export interface ToneModulationDelta {
  /** Multiplied with the phenotype-derived intensityScale. Identity = 1.0. */
  intensityScale: number;
  /** Multiplied with the phenotype-derived speedScale. Identity = 1.0. */
  speedScale: number;
  /** Added to the phenotype-derived durationBias (ms). Identity = 0. */
  durationBias: number;
  /**
   * Per-action variant selection weights.
   * Only populated where the tone meaningfully skews action variants.
   */
  variantWeights?: Record<string, readonly number[]>;
}

/** A single entry in the tone vocabulary table. */
export interface ToneMapping {
  /**
   * Short Chinese prompt fragment injected into the system prompt so the LLM
   * knows how to color its reply. Empty string for `neutral` (no injection).
   */
  promptFragment: string;
  /** Avatar modulation delta applied on top of phenotype-derived values. */
  modulationDelta: ToneModulationDelta;
}

/** Type guard: returns true when `value` is a valid Tone. */
export function isTone(value: unknown): value is Tone {
  return typeof value === 'string' && (TONE_VOCABULARY as readonly string[]).includes(value);
}
