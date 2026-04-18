// NSFW reply service — standalone service for NSFW-mode reply generation.
// Uses a fixed provider (deepseek), no task analysis, no tool use, no card rendering.

import { hasWhitelistCapability, replaceReply } from '@/context/HookContextHelpers';
import type { ConversationHistoryService } from '@/conversation/history';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { WHITELIST_CAPABILITY } from '@/utils/whitelistCapabilities';
import type { ContextEnrichmentStage } from '../pipeline/stages/ContextEnrichmentStage';
import type { PromptManager } from '../prompt/PromptManager';
import type { LLMService } from './LLMService';

/**
 * Standalone NSFW-mode reply generation service.
 * Uses a fixed provider (deepseek), a dedicated prompt template (`llm.nsfw_reply`),
 * and no task analysis, tool use, or card rendering. Output is always plain text.
 * Reuses {@link ContextEnrichmentStage} for memory/RAG retrieval.
 */
export class NsfwReplyService {
  constructor(
    private hookManager: HookManager,
    private llmService: LLMService,
    private conversationHistoryService: ConversationHistoryService,
    private promptManager: PromptManager,
    private contextEnrichmentStage: ContextEnrichmentStage,
  ) {}

  /**
   * Generate reply using NSFW-mode prompt template only (fixed reply flow, no task analysis or search).
   * Used when session is in NSFW mode; reply is set to context.reply.
   * Template uses {{char}} (bot's roleplay character) and {{user}} (user's role/name) for narrative RP.
   */
  async generateNsfwReply(context: HookContext, options?: { char?: string; instruct?: string }): Promise<void> {
    // Gate: do not run LLM when access denied or group lacks reply capability.
    if (context.metadata.get('whitelistDenied')) {
      return;
    }
    if (!hasWhitelistCapability(context, WHITELIST_CAPABILITY.reply)) {
      return;
    }

    const shouldContinue = await this.hookManager.execute('onMessageBeforeAI', context);
    if (!shouldContinue) {
      throw new Error('AI reply generation interrupted by hook');
    }

    await this.hookManager.execute('onAIGenerationStart', context);

    try {
      const historyText = await this.conversationHistoryService.buildConversationHistory(context);
      const sessionId = context.metadata.get('sessionId');
      const memoryVars = await this.contextEnrichmentStage.getMemoryVarsForReply(context);

      // char = bot's roleplay character name; instruct = character persona/details; user = user's role/name
      const char = options?.char ?? '';
      const instruct = options?.instruct?.trim() ?? '';
      const user = `${context.message?.userId?.toString() ?? '未知'}（${context.message?.sender?.nickname ?? '用户'}）`;

      const prompt = this.promptManager.render('llm.nsfw_reply', {
        char,
        instruct,
        user,
        userMessage: context.message.message,
        conversationHistory: historyText,
        groupMemoryText: memoryVars.groupMemoryText,
        userMemoryText: memoryVars.userMemoryText,
        retrievedConversationSection: memoryVars.retrievedConversationSection,
      });
      const baseSystemPrompt = this.promptManager.renderBasePrompt();

      // 300-500 word narrative replies; maxTokens capped for API limits (e.g. DeepSeek 4096)
      const response = await this.llmService.generate(
        prompt,
        {
          temperature: 0.8,
          maxTokens: 4096,
          sessionId,
          systemPrompt: baseSystemPrompt,
        },
        'deepseek', // now only deepseek supports NSFW mode
      );

      // NSFW mode: no card reply, output plain text only
      await this.hookManager.execute('onAIGenerationComplete', context);
      replaceReply(context, response.text, 'ai');
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.error('[NsfwReplyService] Failed to generate NSFW reply:', err);
      throw err;
    }
  }
}
