// ProviderNameMatcher - provider-name prefix trigger matching

import { ProviderRouter } from '@/ai/routing/ProviderRouter';

/**
 * Checks whether a message starts with a known provider alias prefix.
 * When matched, the caller must run a one-shot LLM "prefix-invitation" check
 * to confirm the user actually wants a reply (not just mentioning the provider name).
 */
export class ProviderNameMatcher {
  /**
   * True when the (stripped) message starts with a known provider alias.
   */
  matches(strippedMessage: string): boolean {
    if (!strippedMessage) return false;
    const lower = strippedMessage.toLowerCase();
    const prefixes = ProviderRouter.getProviderTriggerPrefixes();
    return prefixes.some((p) => lower.startsWith(p));
  }
}
