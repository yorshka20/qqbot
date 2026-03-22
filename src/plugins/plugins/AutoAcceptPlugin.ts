// AutoAccept Plugin - automatically accepts friend requests and group invitations

import type { NormalizedRequestEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import { RegisterPlugin } from '../decorators';
import { PluginBase } from '../PluginBase';

interface AutoAcceptPluginConfig {
  /** Whether to auto-accept friend requests. Default: true */
  acceptFriendRequests?: boolean;
  /** Whether to auto-accept group join requests (others applying to join). Default: false */
  acceptGroupJoinRequests?: boolean;
  /** Whether to auto-accept group invitations (bot being invited to join). Default: true */
  acceptGroupInvitations?: boolean;
}

@RegisterPlugin({
  name: 'autoAccept',
  version: '1.0.0',
  description: 'Automatically accepts friend requests and group invitations',
})
export class AutoAcceptPlugin extends PluginBase {
  private acceptFriendRequests = true;
  private acceptGroupJoinRequests = false;
  private acceptGroupInvitations = true;

  private boundHandleRequest = this.handleRequest.bind(this);

  async onInit(): Promise<void> {
    const config = this.pluginConfig?.config as AutoAcceptPluginConfig | undefined;

    if (config?.acceptFriendRequests !== undefined) {
      this.acceptFriendRequests = config.acceptFriendRequests;
    }
    if (config?.acceptGroupJoinRequests !== undefined) {
      this.acceptGroupJoinRequests = config.acceptGroupJoinRequests;
    }
    if (config?.acceptGroupInvitations !== undefined) {
      this.acceptGroupInvitations = config.acceptGroupInvitations;
    }

    logger.info(
      `[AutoAcceptPlugin] Enabled | friendRequests=${this.acceptFriendRequests} groupJoinRequests=${this.acceptGroupJoinRequests} groupInvitations=${this.acceptGroupInvitations}`,
    );

    this.on<NormalizedRequestEvent>('request', this.boundHandleRequest);
  }

  async onDisable(): Promise<void> {
    this.off<NormalizedRequestEvent>('request', this.boundHandleRequest);
    await super.onDisable();
  }

  private async handleRequest(event: NormalizedRequestEvent): Promise<void> {
    if (!this.enabled) return;

    const { requestType, protocol } = event;

    if (requestType === 'friend_request' && this.acceptFriendRequests) {
      const initiatorUid = event.initiator_uid as string;
      const initiatorId = event.initiator_id as number;
      const comment = event.comment as string | undefined;

      logger.info(
        `[AutoAcceptPlugin] Auto-accepting friend request | initiatorId=${initiatorId} comment=${comment ?? ''}`,
      );

      try {
        await this.api.call('accept_friend_request', { initiator_uid: initiatorUid }, protocol);
        logger.info(`[AutoAcceptPlugin] Friend request accepted | initiatorId=${initiatorId}`);
      } catch (error) {
        logger.error(
          `[AutoAcceptPlugin] Failed to accept friend request | initiatorId=${initiatorId} error=${(error as Error).message}`,
        );
      }
    }

    if (requestType === 'group_join_request' && this.acceptGroupJoinRequests) {
      const groupId = event.group_id as number;
      const notificationSeq = event.notification_seq as number;
      const isFiltered = event.is_filtered as boolean;
      const initiatorId = event.initiator_id as number;

      logger.info(
        `[AutoAcceptPlugin] Auto-accepting group join request | groupId=${groupId} initiatorId=${initiatorId}`,
      );

      try {
        await this.api.call(
          'accept_group_request',
          {
            notification_seq: notificationSeq,
            notification_type: 'join_request',
            group_id: groupId,
            is_filtered: isFiltered,
          },
          protocol,
        );
        logger.info(
          `[AutoAcceptPlugin] Group join request accepted | groupId=${groupId} initiatorId=${initiatorId}`,
        );
      } catch (error) {
        logger.error(
          `[AutoAcceptPlugin] Failed to accept group join request | groupId=${groupId} error=${(error as Error).message}`,
        );
      }
    }

    if (requestType === 'group_invited_join_request' && this.acceptGroupJoinRequests) {
      const groupId = event.group_id as number;
      const notificationSeq = event.notification_seq as number;
      const initiatorId = event.initiator_id as number;
      const targetUserId = event.target_user_id as number;

      logger.info(
        `[AutoAcceptPlugin] Auto-accepting invited join request | groupId=${groupId} initiatorId=${initiatorId} targetUserId=${targetUserId}`,
      );

      try {
        await this.api.call(
          'accept_group_request',
          {
            notification_seq: notificationSeq,
            notification_type: 'invited_join_request',
            group_id: groupId,
          },
          protocol,
        );
        logger.info(
          `[AutoAcceptPlugin] Invited join request accepted | groupId=${groupId} initiatorId=${initiatorId}`,
        );
      } catch (error) {
        logger.error(
          `[AutoAcceptPlugin] Failed to accept invited join request | groupId=${groupId} error=${(error as Error).message}`,
        );
      }
    }

    // group_invitation: bot being invited to join a group (now normalized as request event)
    if (requestType === 'group_invitation' && this.acceptGroupInvitations) {
      const groupId = event.group_id as number;
      const invitationSeq = event.invitation_seq as number;
      const initiatorId = event.initiator_id as number;

      if (!groupId || !invitationSeq) return;

      logger.info(
        `[AutoAcceptPlugin] Auto-accepting group invitation | groupId=${groupId} initiatorId=${initiatorId}`,
      );

      try {
        await this.api.call(
          'accept_group_invitation',
          {
            group_id: groupId,
            invitation_seq: invitationSeq,
          },
          protocol,
        );
        logger.info(`[AutoAcceptPlugin] Group invitation accepted | groupId=${groupId}`);
      } catch (error) {
        logger.error(
          `[AutoAcceptPlugin] Failed to accept group invitation | groupId=${groupId} error=${(error as Error).message}`,
        );
      }
    }
  }
}
