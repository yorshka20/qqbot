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
 * Resolve a call's output-token budget for a provider.
 *
 * Callers do not size budgets per task: fallback can land the same request on any
 * provider, and how much of the budget reasoning takes is up to the model, so a cap sized
 * for the visible answer only truncates. A call normally passes nothing and gets the
 * provider's ceiling, which is where the budget is set. Pass `ceiling` when a provider
 * must stop below the default: its API rejects a larger value with a 400, or its output
 * rate makes the default too expensive. An explicit value is still honoured below the
 * ceiling, for the rare caller whose output length is itself the requirement.
 */
export function clampMaxTokens(value: number | undefined, ceiling = DEFAULT_MAX_TOKENS_CEILING): number {
  if (value === undefined) {
    return ceiling;
  }
  return Math.min(Math.max(1, Math.floor(value)), ceiling);
}
