import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface WhitelistPluginConfig {
  userIds?: string[];
  groupIds?: string[];
}

@RegisterPlugin({
  name: 'whitelist',
  version: '1.0.0',
  description:
    'Whitelist plugin: access control only (bot own messages, user/group whitelist). Reply trigger logic is in MessageTriggerPlugin.',
})
export class WhitelistPlugin extends PluginBase {
  private userWhitelist: Set<string> = new Set();
  private groupWhitelist: Set<string> = new Set();
  private hasUserWhitelist = false;
  private hasGroupWhitelist = false;

  async onInit(): Promise<void> {
    this.enabled = true;

    try {
      const pluginConfig = this.pluginConfig?.config as WhitelistPluginConfig;
      if (!pluginConfig) {
        return;
      }

      // Normalize to string so lookup matches message.userId/groupId (which we .toString())
      if (Array.isArray(pluginConfig.userIds)) {
        this.userWhitelist = new Set(pluginConfig.userIds.map((id) => String(id)));
        this.hasUserWhitelist = this.userWhitelist.size > 0;
      }
      if (Array.isArray(pluginConfig.groupIds)) {
        this.groupWhitelist = new Set(pluginConfig.groupIds.map((id) => String(id)));
        this.hasGroupWhitelist = this.groupWhitelist.size > 0;
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Config error:', error);
    }
  }

  /**
   * Run earliest in RECEIVE only. Sets whitelistDenied / postProcessOnly / whitelistUser / whitelistGroup.
   * Bot or private not in whitelist: postProcessOnly (Lifecycle skips to COMPLETE after RECEIVE).
   * Group not in whitelist: whitelistDenied only (PREPROCESS runs, then Lifecycle skips to COMPLETE).
   * Group/private in whitelist: whitelistGroup or whitelistUser (no deny flags).
   */
  @Hook({
    stage: 'onMessageReceived',
    priority: 'HIGHEST',
    order: -10,
  })
  onMessageReceived(context: HookContext): HookResult {
    const message = context.message;
    const messageId = message.id || message.messageId || 'unknown';
    const messageType = message.messageType;
    const userId = message.userId?.toString();
    const groupId = message.groupId?.toString();
    const botSelfId = context.metadata.get('botSelfId');

    // Core access control 1: Ignore bot's own messages
    if (botSelfId && userId === botSelfId) {
      context.metadata.set('postProcessOnly', true);
      context.metadata.set('whitelistDenied', true);
      return true;
    }

    if (messageType === 'private') {
      if (this.hasUserWhitelist && !this.userWhitelist.has(userId)) {
        context.metadata.set('postProcessOnly', true);
        context.metadata.set('whitelistDenied', true);
        logger.info(`[WhitelistPlugin] User not in whitelist | messageId=${messageId} | userId=${userId}`);
        return true;
      }
      context.metadata.set('whitelistUser', true);
      return true;
    }

    // Group: set whitelistDenied only when not in whitelist (so PREPROCESS still runs)
    if (this.hasGroupWhitelist) {
      if (!groupId || !this.groupWhitelist.has(groupId)) {
        context.metadata.set('whitelistDenied', true);
        logger.info(`[WhitelistPlugin] Group not in whitelist | messageId=${messageId} | groupId=${groupId}`);
        return true;
      }
      context.metadata.set('whitelistGroup', true);
    } else {
      context.metadata.set('whitelistGroup', true);
    }
    return true;
  }
}
