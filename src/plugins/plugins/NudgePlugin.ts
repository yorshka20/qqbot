// Nudge Plugin - automatically replies when bot is nudged (戳一戳)

import type { AIManager } from '@/ai/AIManager';
import type { CapabilityType } from '@/ai/capabilities/types';
import { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
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
   * The message to reply when bot is nudged
   */
  replyMessage?: string;
}

@RegisterPlugin({
  name: 'nudge',
  version: '1.0.0',
  description: 'Automatically replies when bot is nudged (戳一戳)',
})
export class NudgePlugin extends PluginBase {
  private messageAPI!: MessageAPI;
  private aiManager!: AIManager;

  async onInit(): Promise<void> {
    // Initialize MessageAPI instance
    this.messageAPI = new MessageAPI(this.api);

    // Get AIManager from DI container
    const container = getContainer();
    this.aiManager = container.resolve<AIManager>(DITokens.AI_MANAGER);

    if (!this.aiManager) {
      logger.warn('[NudgePlugin] AIManager not found in DI container');
    }

    // Register notice event handler
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
    const whitelistConfig = config.getPluginConfig('whitelist') as { groupIds?: string[] } | undefined;
    const groupIds = Array.isArray(whitelistConfig?.groupIds) ? whitelistConfig.groupIds : [];
    if (groupIds.length > 0) {
      const groupIdStr = String(nudgeEvent.groupId);
      if (!groupIds.includes(groupIdStr)) {
        logger.info(`[NudgePlugin] Group not in whitelist, skipping nudge reply | groupId=${nudgeEvent.groupId}`);
        return;
      }
    }

    logger.info(
      `[NudgePlugin] Bot was nudged | senderId=${nudgeEvent.senderId} | groupId=${nudgeEvent.groupId} | receiverId=${nudgeEvent.receiverId}`,
    );

    // Generate status reply
    try {
      const messageSegments = await this.generateStatusReply(nudgeEvent);

      // Create a message event context from notice event for sendFromContext
      // This allows us to use the proper sendFromContext method instead of the deprecated sendGroupMessage
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
   * Generate status reply (same as status command)
   * @param event Group nudge event
   * @returns Message segments
   */
  private async generateStatusReply(event: GroupNudgeNoticeEvent): Promise<MessageSegment[]> {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const groupId = event.groupId !== undefined ? event.groupId.toString() : 'N/A (Private message)';

    // Get current AI providers for each capability
    const capabilities: CapabilityType[] = ['llm', 'vision', 'text2img', 'img2img'];
    const providerInfo: string[] = [];

    if (this.aiManager) {
      for (const capability of capabilities) {
        const provider = this.aiManager.getCurrentProvider(capability);
        const providerName = provider ? provider.name : 'None';
        providerInfo.push(`${capability}: ${providerName}`);
      }
    } else {
      providerInfo.push('AI Manager not available');
    }

    const status = `Bot Status:
Uptime: ${hours}h ${minutes}m ${seconds}s
Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
Group ID: ${groupId}
AI Providers:
  ${providerInfo.join('\n  ')}`;

    const messageBuilder = new MessageBuilder();
    messageBuilder.text(status);
    return messageBuilder.build();
  }
}
