// Coercion helpers for LLM-supplied tool parameters

/** Clamp a model-supplied number into [min, max], falling back when it is not a number. */
export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(raw), min), max);
}
