import type { HookContext, HookResult } from '@/hooks/types';
import { logger } from '@/utils/logger';
import { Hook, RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Legacy: flat list of group IDs; all get full access. Ignored when groups is set. */
interface WhitelistGroupEntry {
  id: string;
  /** When non-empty, group has limited permissions (only these capabilities). Omit or empty = full access. */
  capabilities?: string[];
}

interface WhitelistPluginConfig {
  userIds?: string[];
  groupIds?: string[];
  /** When set, overrides groupIds: each entry defines a group; optional capabilities for limited permissions. */
  groups?: WhitelistGroupEntry[];
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
  /** When groups config is used: allowed group IDs. */
  private groupAllowSet: Set<string> = new Set();
  /** When groups config is used: group id -> list of allowed capabilities. Only entries with non-empty capabilities. */
  private groupCapabilitiesMap: Map<string, string[]> = new Map();
  /** Dynamically allowed groups: id -> capabilities (empty array = full access). Cleared on restart. */
  private dynamicAllowMap: Map<string, string[]> = new Map();
  /** Dynamically denied group IDs (e.g. by RulePlugin schedule). Overlay on config; cleared on restart. */
  private dynamicDenySet: Set<string> = new Set();

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

      if (Array.isArray(pluginConfig.groups) && pluginConfig.groups.length > 0) {
        this.groupAllowSet = new Set();
        this.groupCapabilitiesMap = new Map();
        for (const entry of pluginConfig.groups) {
          const id = String(entry.id).trim();
          if (!id) {
            continue;
          }
          this.groupAllowSet.add(id);
          if (Array.isArray(entry.capabilities) && entry.capabilities.length > 0) {
            this.groupCapabilitiesMap.set(id, entry.capabilities.map((c) => String(c).trim()).filter(Boolean));
          }
        }
        this.groupWhitelist = this.groupAllowSet;
        this.hasGroupWhitelist = this.groupAllowSet.size > 0;
      } else if (Array.isArray(pluginConfig.groupIds)) {
        this.groupWhitelist = new Set(pluginConfig.groupIds.map((id) => String(id)));
        this.hasGroupWhitelist = this.groupWhitelist.size > 0;
        this.groupAllowSet = new Set();
        this.groupCapabilitiesMap = new Map();
      }
    } catch (error) {
      logger.error('[WhitelistPlugin] Config error:', error);
    }
  }

  /**
   * Returns true if the group is effectively allowed (config or dynamic allow, and not dynamically denied).
   */
  private isGroupEffectivelyAllowed(groupId: string): boolean {
    const id = String(groupId);
    const allowedByConfig = !this.hasGroupWhitelist || this.groupWhitelist.has(id);
    const allowedByDynamic = this.dynamicAllowMap.has(id);
    const deniedByDynamic = this.dynamicDenySet.has(id);
    return (allowedByConfig || allowedByDynamic) && !deniedByDynamic;
  }

  /**
   * Returns effective capabilities for an allowed group: config caps, then dynamic caps, then full ([]).
   */
  private getEffectiveCapabilities(groupId: string): string[] {
    const id = String(groupId);
    const configCaps = this.groupCapabilitiesMap.get(id);
    if (configCaps !== undefined) {
      return configCaps;
    }
    const dynamicCaps = this.dynamicAllowMap.get(id);
    if (dynamicCaps !== undefined) {
      return dynamicCaps;
    }
    return [];
  }

  /**
   * Add a group to the whitelist for the current process (dynamic allow). Removes from dynamic deny.
   * @param capabilities - When provided and non-empty, the group has only these capabilities; omit or empty = full access.
   */
  addGroupToWhitelist(groupId: string, capabilities?: string[]): void {
    const id = String(groupId).trim();
    if (!id) {
      return;
    }
    this.dynamicDenySet.delete(id);
    const caps = Array.isArray(capabilities) ? capabilities.map((c) => String(c).trim()).filter(Boolean) : [];
    this.dynamicAllowMap.set(id, caps);
    logger.info(
      `[WhitelistPlugin] Dynamic whitelist: added group ${id}${caps.length > 0 ? ` capabilities=${caps.join(',')}` : ' (full)'}`,
    );
  }

  /**
   * Remove a group from the whitelist for the current process (dynamic deny if was in config, or drop from dynamic allow).
   */
  removeGroupFromWhitelist(groupId: string): void {
    const id = String(groupId).trim();
    if (!id) {
      return;
    }
    this.dynamicAllowMap.delete(id);
    this.dynamicDenySet.add(id);
    logger.info(`[WhitelistPlugin] Dynamic whitelist: removed group ${id}`);
  }

  /**
   * Returns allowed capabilities for a group. undefined = not in whitelist; empty array = full access.
   * Used by callers without HookContext (e.g. ProactiveConversationService when sending proactive message).
   */
  getGroupCapabilities(groupId: string): string[] | undefined {
    const id = String(groupId);
    if (!this.isGroupEffectivelyAllowed(id)) {
      return undefined;
    }
    return this.getEffectiveCapabilities(id);
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
    applicableSources: ['qq-private', 'qq-group', 'discord'],
  })
  onMessageReceived(context: HookContext): HookResult {
    const message = context.message;
    const messageId = message.id || message.messageId || 'unknown';
    const messageType = message.messageType;
    const userId = message.userId?.toString();
    const groupId = message.groupId?.toString();

    // Bot's own messages: do not set postProcessOnly here so PREPROCESS runs and routeCommand can run.
    // MessageTriggerPlugin will set postProcessOnly for bot messages that are not commands (skip reply pipeline only).

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

    // Group: set whitelistDenied only when not effectively in whitelist (config or dynamic allow, and not dynamic deny).
    if (!groupId || !this.isGroupEffectivelyAllowed(groupId)) {
      context.metadata.set('whitelistDenied', true);
      logger.info(`[WhitelistPlugin] Group not in whitelist | messageId=${messageId} | groupId=${groupId}`);
      return true;
    }
    context.metadata.set('whitelistGroup', true);
    const limitedCaps = this.getEffectiveCapabilities(groupId);
    if (limitedCaps.length > 0) {
      context.metadata.set('whitelistGroupCapabilities', limitedCaps);
    }
    return true;
  }
}
