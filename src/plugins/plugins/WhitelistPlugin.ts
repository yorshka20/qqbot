import type { ThreadService } from '@/conversation/ThreadService';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HookContext, HookResult } from '@/hooks/types';
import { MessageUtils } from '@/message/MessageUtils';
import { logger } from '@/utils/logger';
import { Hook, Plugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface WhitelistPluginConfig {
  userIds?: string[];
  groupIds?: string[];
}

@Plugin({
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

  private threadService!: ThreadService

  async onInit(): Promise<void> {
    this.enabled = true;
    // Get dependencies from DI container
    const container = getContainer();
    this.threadService = container.resolve<ThreadService>(DITokens.THREAD_SERVICE);

    if (!this.threadService) {
      throw new Error('[WhitelistPlugin] ThreadService not found');
    }

    try {
      const pluginConfig = this.pluginConfig?.config as WhitelistPluginConfig | undefined;
      if (!pluginConfig) {
        return;
      }

      if (Array.isArray(pluginConfig.userIds)) {
        this.userWhitelist = new Set(pluginConfig.userIds);
        this.hasUserWhitelist = this.userWhitelist.size > 0;
        if (this.hasUserWhitelist) {
          logger.info(`[WhitelistPlugin] User whitelist: ${Array.from(this.userWhitelist).join(', ')}`);
        }
      }

      if (Array.isArray(pluginConfig.groupIds)) {
        this.groupWhitelist = new Set(pluginConfig.groupIds);
        this.hasGroupWhitelist = this.groupWhitelist.size > 0;
        if (this.hasGroupWhitelist) {
          logger.info(`[WhitelistPlugin] Group whitelist: ${Array.from(this.groupWhitelist).join(', ')}`);
        }
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Config error:', error);
    }
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
      logger.info(`[WhitelistPlugin] Bot's own message, skip | messageId=${messageId}`);
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

      // Core access control 2: Group chat requires @bot for same-turn reply.
      // When user does not @bot, we do not run the reply task; only the debounced proactive
      // analysis can decide whether to reply (in current thread, or new thread, or not at all).
      // This avoids replying to off-topic messages when an active thread exists.
      if (!MessageUtils.isAtBot(message, botSelfId)) {
        context.metadata.set('postProcessOnly', true);
        logger.info(`[WhitelistPlugin] Group chat not @bot | messageId=${messageId}`);
        return true;
      }

      // User @bot: allow reply task. Mark so proactive analysis can skip replying to this message (it gets direct reply).
      context.metadata.set('triggeredByAtBot', true);
      if (groupId && this.threadService.hasActiveThread(groupId)) {
        context.metadata.set('inProactiveThread', true);
      }
    }

    return true;
  }
}
