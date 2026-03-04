import type { PromptManager } from '@/ai/prompt/PromptManager';
import type { ProactiveConversationService } from '@/conversation/proactive';
import type { ThreadService } from '@/conversation/thread';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface WhitelistPluginConfig {
  userIds?: string[];
  groupIds?: string[];
  /** Optional global wake words that can trigger direct reply without @bot. */
  wakeWords?: string[];
}

@RegisterPlugin({
  name: 'whitelist',
  version: '1.0.0',
  description:
    'Whitelist plugin that controls message processing based on user and group whitelist. Also handles core access control (bot own messages, @bot requirement)',
})
export class WhitelistPlugin extends PluginBase {
  private userWhitelist: Set<string> = new Set();
  private groupWhitelist: Set<string> = new Set();
  private hasUserWhitelist = false;
  private hasGroupWhitelist = false;
  private globalWakeWords: string[] = [];

  private threadService!: ThreadService;
  private proactiveConversationService!: ProactiveConversationService;

  async onInit(): Promise<void> {
    this.enabled = true;
    // Get dependencies from DI container
    const container = getContainer();
    this.threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);
    this.proactiveConversationService = container.resolve<ProactiveConversationService>(
      DITokens.PROACTIVE_CONVERSATION_SERVICE,
    );

    if (!this.threadService) {
      throw new Error('[WhitelistPlugin] ThreadService not found');
    }
    if (!this.proactiveConversationService) {
      throw new Error('[WhitelistPlugin] ProactiveConversationService not found');
    }

    try {
      const pluginConfig = this.pluginConfig?.config as WhitelistPluginConfig;
      if (!pluginConfig) {
        return;
      }

      if (Array.isArray(pluginConfig.userIds)) {
        this.userWhitelist = new Set(pluginConfig.userIds);
        this.hasUserWhitelist = this.userWhitelist.size > 0;
      }
      if (Array.isArray(pluginConfig.groupIds)) {
        this.groupWhitelist = new Set(pluginConfig.groupIds);
        this.hasGroupWhitelist = this.groupWhitelist.size > 0;
      }
      if (Array.isArray(pluginConfig.wakeWords)) {
        this.globalWakeWords = pluginConfig.wakeWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Config error:', error);
    }
  }

  private parseTriggerWords(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }

  private getGroupWakeWords(groupId: string | undefined): string[] {
    if (!groupId) return [];
    const container = getContainer();
    if (!container.isRegistered(DITokens.PROMPT_MANAGER)) {
      return [];
    }
    const promptManager = container.resolve<PromptManager>(DITokens.PROMPT_MANAGER);
    const preferenceKeys = this.proactiveConversationService?.getGroupPreferenceKeys(groupId) ?? [];
    const words = new Set<string>();
    for (const key of preferenceKeys) {
      const tpl = promptManager.getTemplate(`${key}.trigger`);
      for (const word of this.parseTriggerWords(tpl?.content ?? '')) {
        words.add(word);
      }
    }
    return Array.from(words);
  }

  private matchesWakeWord(groupId: string | undefined, message: string): boolean {
    const text = message.toLowerCase();
    const groupWords = this.getGroupWakeWords(groupId);
    const allWords = [...new Set([...groupWords, ...this.globalWakeWords])];
    return allWords.some((w) => text.includes(w));
  }

  @Hook({
    stage: 'onMessagePreprocess',
    priority: 'HIGHEST',
    order: 0,
  })
  onMessagePreprocess(context: HookContext): HookResult {
    const message = context.message;
    const messageId = message.id || message.messageId || 'unknown';
    const messageType = message.messageType;
    const userId = message.userId?.toString();
    const groupId = message.groupId?.toString();
    const botSelfId = context.metadata.get('botSelfId');

    // Core access control 1: Ignore bot's own messages
    if (botSelfId && userId === botSelfId) {
      context.metadata.set('postProcessOnly', true);
      return true;
    }

    // Whitelist check: only applies if whitelist is configured and non-empty
    if (messageType === 'private') {
      if (this.hasUserWhitelist && !this.userWhitelist.has(userId)) {
        context.metadata.set('postProcessOnly', true);
        logger.info(`[WhitelistPlugin] User not in whitelist | messageId=${messageId} | userId=${userId}`);
        return true;
      }
      context.metadata.set('whitelistUser', true);
      context.metadata.set('contextMode', 'normal');
    } else {
      // Group chat
      if (this.hasGroupWhitelist) {
        if (!groupId || !this.groupWhitelist.has(groupId)) {
          context.metadata.set('postProcessOnly', true);
          logger.info(`[WhitelistPlugin] Group not in whitelist | messageId=${messageId} | groupId=${groupId}`);
          return true;
        }
        context.metadata.set('whitelistGroup', true);
      } else {
        // No group whitelist = allow all groups
        context.metadata.set('whitelistGroup', true);
      }

      // Core access control 2: Group chat allows same-turn reply when (a) user @bot, or (b) replyTrigger=reaction (e.g. reaction-triggered reply).
      // When neither, we do not run the reply task; only the debounced proactive analysis can decide whether to reply.
      const replyTrigger = context.metadata.get('replyTrigger');
      const isAtBot = MessageUtils.isAtBot(message, botSelfId);
      const isWakeWord = this.matchesWakeWord(groupId, message.message ?? '');
      if (replyTrigger !== 'reaction' && !isAtBot && !isWakeWord) {
        context.metadata.set('postProcessOnly', true);
        return true;
      }

      // Allow reply task. Mark so proactive analysis skips replying to this message (it gets direct reply).
      if (isWakeWord && !isAtBot) {
        context.metadata.set('triggeredByWakeWord', true);
      } else {
        context.metadata.set('triggeredByAtBot', true);
      }
      context.metadata.set('contextMode', 'normal');
      if (groupId && this.threadService.hasActiveThread(groupId)) {
        context.metadata.set('inProactiveThread', true);
      }
    }

    return true;
  }
}
