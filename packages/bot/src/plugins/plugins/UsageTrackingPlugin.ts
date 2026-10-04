// Usage tracking plugin — records per-user token/image consumption.
//
// Decoupled by design: the generation producers (GenerationStage for LLM,
// ImageFacadeService for image) stamp an `aiUsage` payload onto the HookContext
// metadata; this plugin is the single consumer that reads it off the
// `onAIGenerationComplete` hook and persists it. LLMService/ImageGenerationService
// have no knowledge of usage tracking.
//
// Always-on: the handlers intentionally do not gate on `this.enabled`. Hook
// handlers are registered regardless of the config enable flag, and tracking is
// infrastructure that should run for every reply without requiring a config entry.

import { ConversationMessageSender } from '@/conversation/ConversationMessageSender';
import { getContainer } from '@/core/DIContainer';
import type { HookContext } from '@/hooks/types';
import { Hook, RegisterPlugin } from '@/plugins/decorators';
import { PluginBase } from '@/plugins/PluginBase';
import { UsageNoticeService } from '@/services/tokenUsage/UsageNoticeService';
import { logger } from '@/utils/logger';

@RegisterPlugin({
  name: 'usage-tracking',
  version: '1.0.0',
  description: 'Records per-user token/image consumption from AI generation hooks',
})
export class UsageTrackingPlugin extends PluginBase {
  private noticeService!: UsageNoticeService;
  private messageSender!: ConversationMessageSender;

  /**
   * Notices earned while a message is being answered. `onAIGenerationComplete` fires before
   * the reply is sent, so they wait here and go out after it in `onMessageComplete`; a
   * context that never completes takes its notices with it when it is collected.
   */
  private readonly pendingNotices = new WeakMap<HookContext, Promise<string[]>[]>();

  async onInit(): Promise<void> {
    this.noticeService = getContainer().resolve(UsageNoticeService);
    this.messageSender = getContainer().resolve(ConversationMessageSender);
  }

  @Hook({ stage: 'onAIGenerationComplete', priority: 'NORMAL', order: 100 })
  async onAIGenerationComplete(context: HookContext): Promise<boolean> {
    const usage = context.metadata.get('aiUsage');
    if (!usage) return true;
    // Consume immediately so dispatch paths that fire the hook more than once
    // (e.g. card render → onAIGenerationComplete) can't double-count.
    context.metadata.delete('aiUsage');

    const userId = context.metadata.get('userId') ?? context.message?.userId;
    if (userId == null || userId === 0 || userId === '') return true;

    const groupId = context.metadata.get('groupId');
    const sender = context.message?.sender;
    const notices = this.noticeService
      .record(
        {
          userId,
          nickname: sender?.card || sender?.nickname || undefined,
          groupId: groupId || undefined,
          protocol: context.message?.protocol ?? 'unknown',
          provider: usage.provider,
          model: usage.model,
          type: usage.type,
          source: usage.source,
          promptTokens: usage.promptTokens,
          cachedPromptTokens: usage.cachedPromptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          imageCount: usage.imageCount,
        },
        { sessionId: String(context.metadata.get('sessionId')), openingPromptTokens: usage.openingPromptTokens },
      )
      .catch((err) => {
        logger.warn('[UsageTrackingPlugin] Failed to record usage:', err);
        return [];
      });
    const pending = this.pendingNotices.get(context) ?? [];
    pending.push(notices);
    this.pendingNotices.set(context, pending);
    return true;
  }

  @Hook({ stage: 'onMessageComplete', priority: 'NORMAL', order: 100 })
  async onMessageComplete(context: HookContext): Promise<boolean> {
    const pending = this.pendingNotices.get(context);
    if (!pending) return true;
    this.pendingNotices.delete(context);

    for (const notice of (await Promise.all(pending)).flat()) {
      try {
        await this.messageSender.sendText(context, notice);
      } catch (err) {
        logger.warn('[UsageTrackingPlugin] Failed to send usage notice:', err);
      }
    }
    return true;
  }
}
