// Usage tracking plugin — records per-user token/image consumption.
//
// Decoupled by design: the generation producers (GenerationStage for LLM,
// ImageFacadeService for image) stamp an `aiUsage` payload onto the HookContext
// metadata; this plugin is the single consumer that reads it off the
// `onAIGenerationComplete` hook and persists it. LLMService/ImageGenerationService
// have no knowledge of usage tracking.
//
// Always-on: the handler intentionally does not gate on `this.enabled`. Hook
// handlers are registered regardless of the config enable flag, and tracking is
// infrastructure that should run for every reply without requiring a config entry.

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext } from '@/hooks/types';
import { Hook, RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import type { TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import { logger } from '@/utils/logger';

@RegisterPlugin({
  name: 'usage-tracking',
  version: '1.0.0',
  description: 'Records per-user token/image consumption from AI generation hooks',
})
export class UsageTrackingPlugin extends PluginBase {
  private usageService: TokenUsageService | null = null;

  /** Resolve lazily on first hook call — robust to plugin/service init ordering. */
  private getUsageService(): TokenUsageService | null {
    if (this.usageService) return this.usageService;
    const container = getContainer();
    if (container.isRegistered(DITokens.TOKEN_USAGE_SERVICE)) {
      this.usageService = container.resolve<TokenUsageService>(DITokens.TOKEN_USAGE_SERVICE);
    }
    return this.usageService;
  }

  @Hook({ stage: 'onAIGenerationComplete', priority: 'NORMAL', order: 100 })
  async onAIGenerationComplete(context: HookContext): Promise<boolean> {
    const usage = context.metadata.get('aiUsage');
    if (!usage) return true;
    // Consume immediately so dispatch paths that fire the hook more than once
    // (e.g. card render → onAIGenerationComplete) can't double-count.
    context.metadata.delete('aiUsage');

    try {
      const userId = context.metadata.get('userId') ?? context.message?.userId;
      if (userId == null || userId === 0 || userId === '') return true;

      const groupId = context.metadata.get('groupId');
      const sender = context.message?.sender;
      this.getUsageService()?.record({
        userId,
        nickname: sender?.card || sender?.nickname || undefined,
        groupId: groupId || undefined,
        protocol: context.message?.protocol ?? 'unknown',
        provider: usage.provider,
        model: usage.model,
        type: usage.type,
        source: usage.source,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        imageCount: usage.imageCount,
      });
    } catch (err) {
      logger.warn('[UsageTrackingPlugin] Failed to record usage:', err);
    }
    return true;
  }
}
