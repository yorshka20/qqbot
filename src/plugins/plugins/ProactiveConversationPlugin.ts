// Proactive Conversation Plugin - schedules group analysis and configures proactive participation (Phase 1)

import type { ProactiveConversationService } from '@/conversation/ProactiveConversationService';
import type { ThreadService } from '@/conversation/ThreadService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface ProactiveConversationPluginConfig {
  /** Groups that have proactive analysis enabled. Same groupId can appear multiple times with different preferenceKey (multiple preferences per group). */
  groups?: Array<{ groupId: string; preferenceKey: string }>;
  /** LLM provider name for preliminary analysis (e.g. "ollama", "doubao"). Must be registered in ai.providers. Default "ollama". */
  analysisProvider?: string;
}

@Plugin({
  name: 'proactiveConversation',
  version: '1.0.0',
  description:
    'Proactive conversation: analyze group messages (Ollama), create thread, and reply without @ when in thread (Phase 1)',
})
export class ProactiveConversationPlugin extends PluginBase {
  private groupIds = new Set<string>();

  private proactiveConversationService!: ProactiveConversationService;
  private threadService!: ThreadService;

  async onInit(): Promise<void> {
    this.enabled = true;

    // Get dependencies from DI container
    const container = getContainer();
    this.threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
    this.proactiveConversationService = container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );
    if (!this.proactiveConversationService) {
      throw new Error('[ProactiveConversationPlugin] ProactiveConversationService not found');
    }
    if (!this.threadService) {
      throw new Error('[ProactiveConversationPlugin] ThreadService not found');
    }

    const pluginConfig = this.pluginConfig?.config as ProactiveConversationPluginConfig | undefined;
    if (pluginConfig?.groups && Array.isArray(pluginConfig.groups)) {
      this.proactiveConversationService.setGroupConfig(pluginConfig.groups);
      this.groupIds = new Set(pluginConfig.groups.map((g) => g.groupId));
      logger.info(`[ProactiveConversationPlugin] Enabled for groups: ${Array.from(this.groupIds).join(', ')}`);
    }
    // Always set provider so config is applied (analysis + final reply use this; default ollama).
    const analysisProvider =
      pluginConfig?.analysisProvider != null && pluginConfig.analysisProvider !== ''
        ? pluginConfig.analysisProvider
        : 'ollama';
    this.proactiveConversationService.setAnalysisProvider(analysisProvider);
    logger.info(`[ProactiveConversationPlugin] Analysis and reply provider: ${analysisProvider}`);
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'NORMAL',
    order: 20,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    if (!this.enabled) return true;
    const inProactive = context.metadata.get('inProactiveThread');
    const groupId = context.message?.groupId?.toString();
    if (!inProactive || !groupId) return true;

    const currentThreadId = this.threadService.getCurrentThreadId(groupId);
    if (currentThreadId) {
      context.metadata.set('proactiveThreadId', currentThreadId);
    }
    return true;
  }

  @Hook({
    stage: 'onMessageComplete',
    priority: 'NORMAL',
    order: 10,
  })
  onMessageComplete(context: HookContext): HookResult {
    if (!this.enabled || !this.proactiveConversationService || this.groupIds.size === 0) return true;

    const messageType = context.message?.messageType;
    const groupId = context.message?.groupId?.toString();
    if (messageType !== 'group' || !groupId) return true;

    if (!this.groupIds.has(groupId)) return true;

    // Do not trigger analysis on bot's own messages (avoid repeated proactive replies)
    const botSelfId = context.metadata.get('botSelfId');
    const userId = context.message?.userId?.toString();
    if (botSelfId && userId === botSelfId) return true;

    // Do not run proactive analysis when the message was @ bot: that message already gets a direct reply.
    if (context.metadata.get('triggeredByAtBot') === true) return true;

    this.proactiveConversationService.scheduleForGroup(groupId);
    return true;
  }
}
