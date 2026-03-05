/**
 * Prefix Invitation Check Service
 * Lightweight LLM call to decide whether a message that matched provider-name prefix
 * actually invites the bot to reply (to avoid wasting tokens on full reply when not intended).
 */

import type { AIManager } from '@/ai/AIManager';
import type { LLMCapability } from '@/ai/capabilities/LLMCapability';
import { isLLMCapability } from '@/ai/capabilities/LLMCapability';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { type PrefixInvitationResult, PrefixInvitationSchema } from '@/ai/schemas/prefixInvitation';
import { type ExtractStrategy, parseLlmJson } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';

const EXTRACT_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'braceMatch', 'regex'];

const DEFAULT_RESULT: PrefixInvitationResult = {
  shouldReply: false,
  reason: undefined,
};

export interface PrefixInvitationCheckOptions {
  /** LLM provider name for the check. If not set, uses current default LLM provider. */
  providerName?: string;
}

export class PrefixInvitationCheckService {
  constructor(
    private aiManager: AIManager,
    private promptManager: PromptManager,
  ) {}

  /**
   * Check whether the user message (which started with a provider prefix) clearly invites a reply.
   * Uses default LLM provider when options.providerName is not set.
   * Returns shouldReply=false when provider is unavailable or parse fails (fail closed).
   */
  async check(messageText: string, options?: PrefixInvitationCheckOptions): Promise<PrefixInvitationResult> {
    const provider =
      options?.providerName != null
        ? this.aiManager.getProvider(options.providerName)
        : this.aiManager.getDefaultProvider('llm');
    const providerName = provider?.name;
    if (!provider || !isLLMCapability(provider) || !provider.isAvailable()) {
      return DEFAULT_RESULT;
    }
    const llm = provider as LLMCapability;

    const template = this.promptManager.getTemplate('analysis.prefix_invitation');
    if (!template) {
      logger.debug('[PrefixInvitationCheckService] Template analysis.prefix_invitation not found; skipping check');
      return { shouldReply: true };
    }

    const prompt = this.promptManager.render('analysis.prefix_invitation', {
      messageText,
    });

    try {
      const response = await llm.generate(prompt, {
        temperature: 0.1,
        maxTokens: 256,
        reasoningEffort: 'minimal',
      });
      const text = (response.text || '').trim();
      const result = parseLlmJson(text, PrefixInvitationSchema, { strategies: EXTRACT_STRATEGIES });
      if (result == null) {
        logger.debug('[PrefixInvitationCheckService] No valid JSON; treating as shouldReply=false');
        return DEFAULT_RESULT;
      }
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(`[PrefixInvitationCheckService] Provider "${providerName}" call failed:`, err);
      return DEFAULT_RESULT;
    }
  }
}
