// Proactive Conversation Plugin - schedules group analysis and configures proactive participation (Phase 1)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveConversationService } from '@/conversation/proactive';
import type { ThreadService } from '@/conversation/thread';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Template name pattern for trigger words: prompts/preference/{preferenceKey}/trigger.txt (one word per line). */
const TRIGGER_TEMPLATE_SUFFIX = '.trigger';

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
  /** groupId -> preferenceKeys[] (each group can have multiple preferences). */
  private groupPreferenceKeys = new Map<string, string[]>();
  /** preferenceKey -> trigger words from prompts/preference/{preferenceKey}/trigger.txt (one word per line). */
  private triggerWords: Record<string, string[]> = {};
  private triggerAccumulator: Record<string, number> = {};
  private accumulatorThreshold = 5;
  private defaultAnalysisProvider = 'ollama';

  private proactiveConversationService!: ProactiveConversationService;
  private threadService!: ThreadService;

  /**
   * Parse template content into trigger words: one per line, skip empty and # lines.
   */
  private parseTriggerWordsContent(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  /**
   * Load trigger words for one preference from prompts/preference/{preferenceKey}/trigger.txt via PromptManager.
   * Template name is "preference.{preferenceKey}.trigger".
   */
  private loadTriggerWordsForPreference(promptManager: PromptManager, preferenceKey: string): void {
    const templateName = `preference.${preferenceKey}${TRIGGER_TEMPLATE_SUFFIX}`;
    const template = promptManager.getTemplate(templateName);
    if (!template?.content) {
      return;
    }
    const words = this.parseTriggerWordsContent(template.content);
    this.triggerWords[preferenceKey] = words;
    logger.info(`[ProactiveConversationPlugin] Loaded ${words.length} trigger words for preference "${preferenceKey}" from preference/${preferenceKey}/trigger.txt`);
  }

  /**
   * Get all trigger words for a group (union of trigger words of all its preference keys).
   */
  private getTriggerWordsForGroup(groupId: string): string[] {
    const preferenceKeys = this.groupPreferenceKeys.get(groupId) ?? [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const key of preferenceKeys) {
      const words = this.triggerWords[key] ?? [];
      for (const w of words) {
        if (!seen.has(w)) {
          seen.add(w);
          result.push(w);
        }
      }
    }
    return result;
  }

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
      // Build groupId -> preferenceKeys[] and load trigger words per preference from prompts/preference/{key}/trigger.txt
      const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
      const preferenceKeysSeen = new Set<string>();
      for (const g of pluginConfig.groups) {
        const list = this.groupPreferenceKeys.get(g.groupId) ?? [];
        if (!list.includes(g.preferenceKey)) {
          list.push(g.preferenceKey);
        }
        this.groupPreferenceKeys.set(g.groupId, list);
        this.triggerAccumulator[g.groupId] = 0;
        if (promptManager && !preferenceKeysSeen.has(g.preferenceKey)) {
          preferenceKeysSeen.add(g.preferenceKey);
          this.loadTriggerWordsForPreference(promptManager, g.preferenceKey);
        }
      }
      logger.info(`[ProactiveConversationPlugin] Enabled for groups: ${Array.from(this.groupIds).join(', ')}`);
    }
    // Always set provider so config is applied (analysis + final reply use this; default ollama).
    const analysisProvider = pluginConfig?.analysisProvider ?? this.defaultAnalysisProvider;
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
    if (!this.enabled || this.groupIds.size === 0) return true;

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

    // if trigger words (from any of this group's preferences) are matched, schedule analysis directly
    const triggerWords = this.getTriggerWordsForGroup(groupId);
    if (triggerWords.length > 0 && triggerWords.some((word) => context.message?.message?.toLowerCase().includes(word))) {
      this.proactiveConversationService.scheduleForGroup(groupId);
    } else {
      // if trigger words are not matched, accumulate trigger count
      this.triggerAccumulator[groupId] += 1;
      if (this.triggerAccumulator[groupId] >= this.accumulatorThreshold) {
        this.proactiveConversationService.scheduleForGroup(groupId);
        this.triggerAccumulator[groupId] = 0;
      }
    }
    return true;
  }
}
