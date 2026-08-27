/**
 * Ceiling applied to every provider's output-token budget unless that provider's
 * API caps it lower. Not a vendor limit — a policy one: ~20k tokens is over ten
 * thousand Chinese characters, more than any task here produces, so anything
 * above it is a caller mistake rather than a request worth forwarding.
 */
const DEFAULT_MAX_TOKENS_CEILING = 20_000;

/**
 * Clamp a caller's output-token budget to what a provider accepts.
 *
 * Callers size their budget for the task (see `TOKEN_BUDGET`) without knowing which
 * provider will serve the call — fallback can land the same request on any of them.
 * A budget above the API's ceiling is rejected outright (DeepSeek answers 400 for
 * max_tokens > 8192), so the ceiling has to be applied here, where the provider and
 * its limit are both known. Pass `apiLimit` only when the vendor's own cap is lower
 * than the policy ceiling.
 *
 * `undefined` passes through: it means "no cap requested", and providers that omit
 * the field let the model use its own full budget.
 */
export function clampMaxTokens(value: number, apiLimit?: number): number;
export function clampMaxTokens(value: number | undefined, apiLimit?: number): number | undefined;
export function clampMaxTokens(value: number | undefined, apiLimit?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(Math.max(1, Math.floor(value)), apiLimit ?? DEFAULT_MAX_TOKENS_CEILING);
}
