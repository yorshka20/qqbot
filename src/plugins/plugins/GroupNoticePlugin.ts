// GroupNotice Plugin - notifies group member changes (join/leave)

import { MessageAPI } from '@/api/methods/MessageAPI';
import type { Config } from '@/core/config';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { NormalizedMessageEvent, NormalizedNoticeEvent } from '@/events/types';
import { MessageBuilder } from '@/message/MessageBuilder';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface GroupNoticePluginConfig {
  /**
   * List of group IDs to enable notifications for.
   * Only groups in this list will receive member change notifications.
   */
  groupIds: string[];
  /**
   * Custom message template for member join.
   * Placeholders: {userId}, {groupId}
   * Default: "欢迎新成员 {userId} 加入群聊！"
   */
  joinMessage?: string;
  /**
   * Custom message template for member leave.
   * Placeholders: {userId}, {groupId}
   * Default: "成员 {userId} 已离开群聊。"
   */
  leaveMessage?: string;
}

@RegisterPlugin({
  name: 'groupNotice',
  version: '1.0.0',
  description: 'Notifies group member changes (join/leave)',
})
export class GroupNoticePlugin extends PluginBase {
  private messageAPI!: MessageAPI;
  private enabledGroupIds: Set<string> = new Set();
  private joinMessageTemplate = '欢迎新成员 {userId} 加入群聊！';
  private leaveMessageTemplate = '成员 {userId} 已离开群聊。';

  async onInit(): Promise<void> {
    this.messageAPI = new MessageAPI(this.api);

    try {
      const pluginConfig = this.pluginConfig?.config as GroupNoticePluginConfig | undefined;

      if (pluginConfig?.groupIds && Array.isArray(pluginConfig.groupIds)) {
        for (const id of pluginConfig.groupIds) {
          this.enabledGroupIds.add(String(id));
        }
      }

      if (pluginConfig?.joinMessage) {
        this.joinMessageTemplate = pluginConfig.joinMessage;
      }
      if (pluginConfig?.leaveMessage) {
        this.leaveMessageTemplate = pluginConfig.leaveMessage;
      }
    } catch (error) {
      logger.error('[GroupNoticePlugin] Error loading config:', error);
      this.enabled = false;
      return;
    }

    if (this.enabledGroupIds.size === 0) {
      logger.warn('[GroupNoticePlugin] No group IDs configured, plugin will not send any notifications');
    }

    this.on<NormalizedNoticeEvent>('notice', this.handleNotice.bind(this));
  }

  async onDisable(): Promise<void> {
    this.off<NormalizedNoticeEvent>('notice', this.handleNotice.bind(this));
    await super.onDisable();
  }

  private async handleNotice(event: NormalizedNoticeEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const { noticeType, groupId, userId } = event;

    if (noticeType !== 'group_member_increase' && noticeType !== 'group_member_decrease') {
      return;
    }

    if (!groupId) {
      return;
    }

    const groupIdStr = String(groupId);
    if (!this.enabledGroupIds.has(groupIdStr)) {
      return;
    }

    const userIdStr = userId ? String(userId) : '未知';
    const isJoin = noticeType === 'group_member_increase';

    const template = isJoin ? this.joinMessageTemplate : this.leaveMessageTemplate;
    if (!template) {
      // do not send if template is not set
      return;
    }

    const text = template.replace(/\{userId\}/g, userIdStr).replace(/\{groupId\}/g, groupIdStr);

    logger.info(`[GroupNoticePlugin] Member ${isJoin ? 'joined' : 'left'} | groupId=${groupId} | userId=${userId}`);

    try {
      const messageSegments = new MessageBuilder().text(text).build();

      const messageEvent: NormalizedMessageEvent = {
        id: event.id,
        type: 'message',
        timestamp: event.timestamp,
        protocol: event.protocol,
        messageType: 'group',
        userId: userId ?? 0,
        groupId,
        message: '',
      };

      await this.messageAPI.sendFromContext(messageSegments, messageEvent);
    } catch (error) {
      logger.error(
        `[GroupNoticePlugin] Failed to send notification | groupId=${groupId} | error=${(error as Error).message}`,
      );
    }
  }
}
