// Message Trigger Plugin - single place that decides whether to run the reply pipeline (trigger only; no side effects)

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { ProviderRouter } from '@/ai/routing/ProviderRouter';
import type { ProactiveConversationService } from '@/conversation/proactive';
import type { ThreadService } from '@/conversation/thread';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

export interface MessageTriggerPluginConfig {
  /** Global wake words that can trigger direct reply without @bot. */
  wakeWords?: string[];
  /** When true (default), message starting with provider alias (e.g. "claude", "deepseek") + space/colon triggers reply with that provider. */
  providerNamesAsTrigger?: boolean;
}

@RegisterPlugin({
  name: 'messageTrigger',
  version: '1.0.0',
  description:
    'Unified message trigger: decides if message should activate reply pipeline (@bot, reaction, wake words, provider-name prefix). Trigger only; downstream modules handle behavior.',
})
export class MessageTriggerPlugin extends PluginBase {
  private globalWakeWords: string[] = [];
  private providerNamesAsTrigger = true;

  private promptManager!: PromptManager;
  private proactiveConversationService!: ProactiveConversationService;
  private threadService!: ThreadService;

  async onInit(): Promise<void> {
    this.enabled = true;
    const container = getContainer();
    this.promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    this.proactiveConversationService = container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );
    this.threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);

    const pluginConfig = this.pluginConfig?.config as MessageTriggerPluginConfig | undefined;
    if (pluginConfig) {
      if (Array.isArray(pluginConfig.wakeWords)) {
        this.globalWakeWords = pluginConfig.wakeWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
      }
      this.providerNamesAsTrigger = pluginConfig.providerNamesAsTrigger ?? true;
    }
    logger.info(
      `[MessageTriggerPlugin] Enabled | wakeWords=${this.globalWakeWords.length} providerNamesAsTrigger=${this.providerNamesAsTrigger}`,
    );
  }

  private parseTriggerWords(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  private getGroupWakeWords(groupId: string | undefined): string[] {
    if (!groupId) {
      return [];
    }
    const preferenceKeys = this.proactiveConversationService?.getGroupPreferenceKeys(groupId) ?? [];
    const words = new Set<string>();
    for (const key of preferenceKeys) {
      const tpl = this.promptManager.getTemplate(`${key}.trigger`);
      for (const word of this.parseTriggerWords(tpl?.content ?? '')) {
        words.add(word);
      }
    }
    return Array.from(words);
  }

  /** Returns which wake-word source matched, or null if none. Preference is checked before config. */
  private getWakeWordTriggerSource(
    groupId: string | undefined,
    message: string,
  ): 'wakeWordPreference' | 'wakeWordConfig' | null {
    const text = message.toLowerCase();
    const preferenceWords = this.getGroupWakeWords(groupId);
    const matchedPreference = preferenceWords.some((w) => text.includes(w));
    if (matchedPreference) {
      return 'wakeWordPreference';
    }
    const matchedConfig = this.globalWakeWords.some((w) => text.includes(w));
    if (matchedConfig) {
      return 'wakeWordConfig';
    }
    return null;
  }

  /** True when message starts with a known provider alias followed by space or colon (and has content after). */
  private matchesProviderNameTrigger(message: string): boolean {
    if (!this.providerNamesAsTrigger) {
      return false;
    }
    const raw = (message ?? '').trim();
    if (!raw) {
      return false;
    }
    const lower = raw.toLowerCase();
    const prefixes = ProviderRouter.getProviderTriggerPrefixes();
    for (const p of prefixes) {
      if (!lower.startsWith(p)) {
        continue;
      }
      const restStart = p.length;
      if (restStart >= lower.length) {
        continue;
      }
      const nextChar = lower[restStart];
      if (nextChar === ' ' || nextChar === ':' || nextChar === '：') {
        return true;
      }
    }
    return false;
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'HIGHEST',
    order: -1,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    const message = context.message;
    const messageType = message.messageType;
    const userId = message.userId?.toString();
    const groupId = message.groupId?.toString();
    const botSelfId = context.metadata.get('botSelfId');
    const messageText = message.message ?? '';

    // Bot self: do not run reply pipeline
    if (botSelfId && userId === botSelfId) {
      context.metadata.set('postProcessOnly', true);
      return true;
    }

    // Private: do not set postProcessOnly here; WhitelistPlugin will filter by user whitelist
    if (messageType === 'private') {
      return true;
    }

    // Group: decide if message triggers reply (collect from config + preference; distinguish source for analysis)
    const replyTrigger = context.metadata.get('replyTrigger');
    const isAtBot = MessageUtils.isAtBot(message, botSelfId);
    const wakeWordSource = this.getWakeWordTriggerSource(groupId, messageText);
    const isWakeWord = wakeWordSource !== null;
    const isProviderNameTrigger = this.matchesProviderNameTrigger(messageText);

    const allowed = replyTrigger === 'reaction' || isAtBot || isWakeWord || isProviderNameTrigger;

    if (!allowed) {
      context.metadata.set('postProcessOnly', true);
      return true;
    }

    // Allow reply; set single trigger type for downstream
    let replyTriggerType: 'at' | 'reaction' | 'wakeWordConfig' | 'wakeWordPreference' | 'providerName';
    if (replyTrigger === 'reaction') {
      replyTriggerType = 'reaction';
    } else if (isAtBot) {
      replyTriggerType = 'at';
    } else if (isWakeWord && wakeWordSource) {
      replyTriggerType = wakeWordSource;
    } else if (isProviderNameTrigger) {
      replyTriggerType = 'providerName';
    } else {
      replyTriggerType = 'reaction';
    }
    context.metadata.set('replyTriggerType', replyTriggerType);
    context.metadata.set('contextMode', 'normal');
    if (groupId && this.threadService.hasActiveThread(groupId)) {
      context.metadata.set('inProactiveThread', true);
    }

    return true;
  }
}
