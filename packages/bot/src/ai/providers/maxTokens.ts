/**
 * Ceiling applied to every provider's output-token budget unless that provider sets a
 * lower one. Not a vendor limit — a policy one, sized for reasoning models: their hidden
 * CoT alone runs to tens of thousands of tokens, and it is charged against this same
 * budget, so a tighter cap returns a finished chain of thought with no answer.
 */
const DEFAULT_MAX_TOKENS_CEILING = 50_000;

/**
 * Ceiling for providers billed at premium output rates. There a runaway reasoning budget
 * is a real bill rather than a slow call, so they stop near the largest answer any task
 * here produces (~20k tokens is over ten thousand Chinese characters).
 */
export const PREMIUM_MAX_TOKENS_CEILING = 20_000;

/**
 * Clamp a caller's output-token budget to what a provider accepts.
 *
 * Callers size their budget for the task (see `TOKEN_BUDGET`) without knowing which
 * provider will serve the call — fallback can land the same request on any of them.
 * The ceiling therefore has to be applied here, where the provider is known. Pass
 * `ceiling` when a provider must stop below the default: its API rejects a larger
 * value with a 400, or its output rate makes the default too expensive.
 *
 * `undefined` passes through: it means "no cap requested", and providers that omit
 * the field let the model use its own full budget.
 */
export function clampMaxTokens(value: number, ceiling?: number): number;
export function clampMaxTokens(value: number | undefined, ceiling?: number): number | undefined;
export function clampMaxTokens(value: number | undefined, ceiling?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(Math.max(1, Math.floor(value)), ceiling ?? DEFAULT_MAX_TOKENS_CEILING);
}
