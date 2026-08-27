/**
 * Output-token budgets for LLM calls.
 *
 * A cap is a ceiling, not a reservation: a model that answers in 20 tokens costs
 * 20 tokens whatever the cap says. On a reasoning model, though, hidden CoT is
 * charged against this same budget, so a cap sized for the visible answer gets
 * spent on thinking and the call returns nothing — under `jsonMode` the provider
 * rejects the truncated object outright (Groq: 400 json_validate_failed). Budgets
 * here are therefore sized for "reasoning + answer", never for the answer alone.
 */
export const TOKEN_BUDGET = {
  /** Short structured verdicts: classifiers, routing decisions, small JSON objects. */
  decision: 4096,
  /** Prose or medium JSON: summaries, analyses, prompt rewriting, image params. */
  analysis: 8192,
  /** Whole-document output: memory extract/merge, batch report JSON. */
  document: 20_000,
} as const;
