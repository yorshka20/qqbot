/**
 * Pick the reasoning level a model will run a request at: the requested level when the
 * model accepts it, else the nearest accepted level above it, else the model's highest.
 *
 * The set of accepted levels is a property of the model, not of the provider — vendors
 * add and drop levels between model generations and reject anything outside the set with
 * a 400. Rounding up rather than down keeps a request from getting less reasoning than it
 * asked for; `accepted` and `ascending` must both be ordered from least to most reasoning.
 */
export function pickAcceptedReasoningLevel<Level>(
  requested: Level,
  accepted: readonly Level[],
  ascending: readonly Level[],
): Level {
  const requestedRank = ascending.indexOf(requested);
  return accepted.find((level) => ascending.indexOf(level) >= requestedRank) ?? accepted[accepted.length - 1];
}
