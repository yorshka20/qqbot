// RelationshipUpdater — coarse deterministic write path for persona_relationships.
//
// Called after each reply completes to bump affinity + familiarity based on
// a keyword/regex scan of the incoming user message. No LLM is used; all
// classification is pure string matching.
//
// Affinity rules (only the first matching sign wins):
//   positive keywords found → affinityDelta = +AFFINITY_BUMP
//   negative keywords found → affinityDelta = -AFFINITY_BUMP
//   otherwise               → affinityDelta = 0
//
// Familiarity is always incremented by FAMILIARITY_PER_MESSAGE regardless of
// affinity (each interaction grows familiarity, regardless of tone).
//
// TODO [3/3]: tag classification (e.g. detect repeated negative pattern → 抬杠党)

import type { EpigeneticsStore } from '../epigenetics/EpigeneticsStore';

const AFFINITY_BUMP = 0.01;
const FAMILIARITY_PER_MESSAGE = 0.001;

/** Positive sentiment keywords. */
const POSITIVE_KEYWORDS = ['谢谢', '喜欢', '666', '真棒', '可爱'];

/** Negative sentiment keywords. */
const NEGATIVE_KEYWORDS = ['不对', '抬杠', '烦', '无聊'];

/**
 * Classify a user message text into an affinity delta.
 * Returns +AFFINITY_BUMP, -AFFINITY_BUMP, or 0.
 */
export function classifyAffinityDelta(text: string): number {
  const hasPositive = POSITIVE_KEYWORDS.some((kw) => text.includes(kw));
  if (hasPositive) {
    return AFFINITY_BUMP;
  }
  const hasNegative = NEGATIVE_KEYWORDS.some((kw) => text.includes(kw));
  if (hasNegative) {
    return -AFFINITY_BUMP;
  }
  return 0;
}

/**
 * RelationshipUpdater — updates the persona_relationships row after
 * each reply completion. Constructed with the shared EpigeneticsStore.
 *
 * Failures are swallowed and logged by the caller (PersonaCompletionHookPlugin)
 * so they never interrupt reply flow.
 */
export class RelationshipUpdater {
  constructor(private readonly store: EpigeneticsStore) {}

  /**
   * Bump relationship scores for a persona↔user pair.
   *
   * @param personaId - the bot's persona ID (from mind config)
   * @param userId    - the sender's user ID (string form of metadata.userId)
   * @param userText  - the raw user message text for affinity classification
   */
  async update(personaId: string, userId: string, userText: string): Promise<void> {
    const affinityDelta = classifyAffinityDelta(userText);
    await this.store.bumpRelationship(personaId, userId, {
      affinityDelta,
      familiarityDelta: FAMILIARITY_PER_MESSAGE,
    });
  }
}
