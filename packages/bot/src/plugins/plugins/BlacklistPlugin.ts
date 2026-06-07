import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface BlacklistPluginConfig {
  /** Blocked everywhere (all groups + private). */
  userIds?: (string | number)[];
  /** Per-group blacklist: groupId -> blocked user IDs. */
  groups?: Record<string, (string | number)[]>;
}

/**
 * Blacklist plugin: access control. A blacklisted sender's message gets
 * whitelistDenied at the earliest stage, so Lifecycle skips to COMPLETE and
 * no reply (command / AI / proactive) is produced. Mirrors WhitelistPlugin but
 * inverts the decision; runs earlier (order -20) so it wins over whitelist.
 *
 * Config is hand-edited in config.d/plugins.jsonc — no runtime mutation.
 */
@RegisterPlugin({
  name: 'blacklist',
  version: '1.0.0',
  description: 'Blacklist plugin: blacklisted users cannot trigger any bot response (global or per-group).',
})
export class BlacklistPlugin extends PluginBase {
  /** Blocked in every group and private chat. */
  private globalBlacklist: Set<string> = new Set();
  /** groupId -> blocked user IDs. */
  private groupBlacklist: Map<string, Set<string>> = new Map();

  async onInit(): Promise<void> {
    this.enabled = true;

    try {
      const pluginConfig = this.pluginConfig?.config as BlacklistPluginConfig | undefined;
      if (!pluginConfig) {
        return;
      }

      if (Array.isArray(pluginConfig.userIds)) {
        this.globalBlacklist = new Set(pluginConfig.userIds.map((id) => String(id)));
      }

      if (pluginConfig.groups && typeof pluginConfig.groups === 'object') {
        for (const [groupId, userIds] of Object.entries(pluginConfig.groups)) {
          if (!Array.isArray(userIds)) {
            continue;
          }
          this.groupBlacklist.set(String(groupId), new Set(userIds.map((id) => String(id))));
        }
      }
    } catch (error) {
      logger.error('[BlacklistPlugin] Config error:', error);
    }
  }

  private isBlacklisted(userId: string, groupId?: string): boolean {
    if (this.globalBlacklist.has(userId)) {
      return true;
    }
    if (groupId) {
      return this.groupBlacklist.get(groupId)?.has(userId) ?? false;
    }
    return false;
  }

  /**
   * Run earliest in RECEIVE (before WhitelistPlugin). Blacklisted sender:
   * set whitelistDenied so Lifecycle skips to COMPLETE — no reply path runs.
   */
  @Hook({
    stage: 'onMessageReceived',
    priority: 'HIGHEST',
    order: -20,
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  onMessageReceived(context: HookContext): HookResult {
    const message = context.message;
    const userId = message.userId?.toString();
    if (!userId) {
      return true;
    }
    const groupId = message.groupId?.toString();

    if (this.isBlacklisted(userId, groupId)) {
      context.metadata.set('whitelistDenied', true);
      const messageId = message.id || message.messageId || 'unknown';
      logger.info(
        `[BlacklistPlugin] Blocked blacklisted user | messageId=${messageId} | userId=${userId}${groupId ? ` | groupId=${groupId}` : ''}`,
      );
    }
    return true;
  }
}
