// Nudge Plugin - automatically replies when bot is nudged (戳一戳)

import type { AIManager } from '@/ai/AIManager';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { HealthCheckManager } from '@/core/health';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import type { PluginManager } from '@/plugins/PluginManager';
import type { WhitelistPlugin } from '@/plugins/plugins/WhitelistPlugin';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

/** Group nudge notice: required fields for type guard. */
interface GroupNudgeNoticeEvent extends NormalizedNoticeEvent {
  noticeType: 'group_nudge';
  senderId: number;
  receiverId: number;
  groupId: number;
}

/**
 * Nudge Plugin configuration
 * Used in config.jsonc plugins.list[].config
 */
export interface NudgePluginConfig {
  /**
   * Optional custom message to reply when bot is nudged.
   * If set, this is sent instead of the rich status block.
   */
  replyMessage?: string;
  /**
   * When true, always reply with rich bot status even if replyMessage is set.
   * Default: false (replyMessage takes precedence when set).
   */
  alwaysUseStatus?: boolean;
}

@RegisterPlugin({
  name: 'nudge',
  version: '1.1.0',
  description: 'Automatically replies when bot is nudged (戳一戳)',
})
export class NudgePlugin extends PluginBase {
  private messageAPI!: MessageAPI;
  private aiManager!: AIManager | null;
  private healthCheckManager!: HealthCheckManager | null;

  async onInit(): Promise<void> {
    this.messageAPI = new MessageAPI(this.api);

    const container = getContainer();
    this.aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER) ?? null;
    try {
      this.healthCheckManager = container.resolve<HealthCheckManager>(DITokens.HEALTH_CHECK_MANAGER) ?? null;
    } catch {
      this.healthCheckManager = null;
    }

    if (!this.aiManager) {
      logger.warn('[NudgePlugin] AIManager not found in DI container');
    }

    this.on<NormalizedNoticeEvent>('notice', this.handleNotice.bind(this));
  }

  async onDisable(): Promise<void> {
    // Unregister notice event handler
    this.off<NormalizedNoticeEvent>('notice', this.handleNotice.bind(this));
    await super.onDisable();
  }

  /**
   * Handle notice events
   * Check if it's a group_nudge event and bot is the receiver
   */
  private async handleNotice(event: NormalizedNoticeEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // Only handle group_nudge events
    if (event.noticeType !== 'group_nudge') {
      return;
    }

    const nudgeEvent = event as GroupNudgeNoticeEvent;
    if (
      typeof nudgeEvent.senderId !== 'number' ||
      typeof nudgeEvent.receiverId !== 'number' ||
      typeof nudgeEvent.groupId !== 'number'
    ) {
      logger.warn('[NudgePlugin] Invalid group_nudge event structure');
      return;
    }

    const config = getContainer().resolve<Config>(DITokens.CONFIG);
    const botSelfId = config.getConfig().bot?.selfId;
    if (!botSelfId) {
      logger.warn('[NudgePlugin] Bot selfId not found in config');
      return;
    }
    if (nudgeEvent.receiverId.toString() !== String(botSelfId)) {
      return;
    }

    // Whitelist is highest constraint: never respond in non-whitelist groups (notice has no pipeline context)
    const groupIdStr = String(nudgeEvent.groupId);
    const pluginManager = getContainer().resolve<PluginManager>(DITokens.PLUGIN_MANAGER);
    const whitelistPlugin = pluginManager?.getPluginAs<WhitelistPlugin>('whitelist');
    if (whitelistPlugin) {
      if (whitelistPlugin.getGroupCapabilities(groupIdStr) === undefined) {
        logger.info(`[NudgePlugin] Group not in whitelist, skipping nudge reply | groupId=${nudgeEvent.groupId}`);
        return;
      }
    } else {
      const whitelistConfig = config.getPluginConfig('whitelist') as { groupIds?: string[] } | undefined;
      const groupIds = Array.isArray(whitelistConfig?.groupIds) ? whitelistConfig.groupIds : [];
      if (groupIds.length > 0 && !groupIds.includes(groupIdStr)) {
        logger.info(`[NudgePlugin] Group not in whitelist, skipping nudge reply | groupId=${nudgeEvent.groupId}`);
        return;
      }
    }

    logger.info(
      `[NudgePlugin] Bot was nudged | senderId=${nudgeEvent.senderId} | groupId=${nudgeEvent.groupId} | receiverId=${nudgeEvent.receiverId}`,
    );

    try {
      const pluginConfig = this.pluginConfig?.config as NudgePluginConfig | undefined;
      const customMessage =
        pluginConfig?.replyMessage != null && pluginConfig.replyMessage !== '' ? pluginConfig.replyMessage : null;
      const useCustomMessage = customMessage != null && !pluginConfig?.alwaysUseStatus;

      const messageSegments = useCustomMessage
        ? new MessageBuilder().text(customMessage).build()
        : await this.generateStatusReply(nudgeEvent);

      const messageEvent: NormalizedMessageEvent = {
        id: nudgeEvent.id,
        type: 'message',
        timestamp: nudgeEvent.timestamp,
        protocol: nudgeEvent.protocol,
        messageType: 'group',
        userId: nudgeEvent.senderId,
        groupId: nudgeEvent.groupId,
        message: '',
      };

      await this.messageAPI.sendFromContext(messageSegments, messageEvent);

      logger.info(
        `[NudgePlugin] Reply sent successfully | groupId=${nudgeEvent.groupId} | senderId=${nudgeEvent.senderId}`,
      );
    } catch (error) {
      logger.error(
        `[NudgePlugin] Failed to send reply | groupId=${nudgeEvent.groupId} | senderId=${nudgeEvent.senderId}:`,
        error,
      );
    }
  }

  /**
   * Build rich bot status text (uptime, memory, platform, AI providers, optional health).
   * @param event Group nudge event (for groupId / context)
   * @returns Message segments
   */
  private async generateStatusReply(event: GroupNudgeNoticeEvent): Promise<MessageSegment[]> {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const memoryStr = `heap ${heapUsedMB}/${heapTotalMB} MB, rss ${rssMB} MB`;

    const groupId = event.groupId !== undefined ? event.groupId.toString() : 'N/A';
    const config = getContainer().resolve<Config>(DITokens.CONFIG);
    const botSelfId = config.getConfig().bot?.selfId ?? null;
    const botIdStr = botSelfId != null ? String(botSelfId) : 'N/A';

    // Capabilities from AIManager registry
    const capabilities = this.aiManager ? this.aiManager.getRegisteredCapabilities() : [];
    const providerLines: string[] = [];

    // Per-provider health: run check (uses cache when valid, else fetches) so status is always shown
    let providerHealth: Record<string, boolean> | null = null;
    if (this.healthCheckManager) {
      try {
        const result = await this.healthCheckManager.checkHealth('AIManager', { timeout: 8000 });
        if (result.details && typeof result.details.providers === 'object' && result.details.providers !== null) {
          providerHealth = result.details.providers as Record<string, boolean>;
        }
      } catch {
        // keep providerHealth null, lines will show without ✅/❌
      }
    }

    if (this.aiManager) {
      for (const capability of capabilities) {
        const provider = this.aiManager.getCurrentProvider(capability);
        const name = provider ? provider.name : 'None';
        let suffix = '';
        if (provider && providerHealth && typeof providerHealth[provider.name] === 'boolean') {
          suffix = providerHealth[provider.name] ? ' ✅' : ' ❌';
        }
        providerLines.push(`  ${capability}: ${name}${suffix}`);
      }
    } else {
      providerLines.push('  ❌ AI Manager not available');
    }

    const status = `🤖 Bot Status
━━━━━━━━━━
⏱️ Uptime: ${uptimeStr}
💾 Memory: ${memoryStr}
🆔 Bot ID: ${botIdStr}
👥 Group ID: ${groupId}
🧠 AI Providers:
${providerLines.join('\n')}`;

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(status);
    return messageBuilder.build();
  }
}
