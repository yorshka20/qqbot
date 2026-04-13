// Milky API converter utilities
// Converts unified API interface (OneBot11-style naming) to Milky protocol native format

import type {
  AcceptFriendRequestInput,
  AcceptGroupInvitationInput,
  AcceptGroupRequestInput,
  CreateGroupFolderInput,
  DeleteFriendInput,
  DeleteGroupAnnouncementInput,
  DeleteGroupFileInput,
  DeleteGroupFolderInput,
  GetCookiesInput,
  GetForwardedMessagesInput,
  GetFriendInfoInput,
  GetFriendListInput,
  GetFriendRequestsInput,
  GetGroupAnnouncementsInput,
  GetGroupEssenceMessagesInput,
  GetGroupFileDownloadUrlInput,
  GetGroupFilesInput,
  GetGroupInfoInput,
  GetGroupListInput,
  GetGroupMemberInfoInput,
  GetGroupMemberListInput,
  GetGroupNotificationsInput,
  GetHistoryMessagesInput,
  GetMessageInput,
  GetPrivateFileDownloadUrlInput,
  GetResourceTempUrlInput,
  GetUserProfileInput,
  KickGroupMemberInput,
  MarkMessageAsReadInput,
  MoveGroupFileInput,
  OutgoingSegment,
  QuitGroupInput,
  RecallGroupMessageInput,
  RecallPrivateMessageInput,
  RejectFriendRequestInput,
  RejectGroupInvitationInput,
  RejectGroupRequestInput,
  RenameGroupFileInput,
  RenameGroupFolderInput,
  SendFriendNudgeInput,
  SendGroupAnnouncementInput,
  SendGroupMessageInput,
  SendGroupNudgeInput,
  SendPrivateMessageInput,
  SendProfileLikeInput,
  SetAvatarInput,
  SetBioInput,
  SetGroupAvatarInput,
  SetGroupEssenceMessageInput,
  SetGroupMemberAdminInput,
  SetGroupMemberCardInput,
  SetGroupMemberMuteInput,
  SetGroupMemberSpecialTitleInput,
  SetGroupNameInput,
  SetGroupWholeMuteInput,
  SetNicknameInput,
} from '@saltify/milky-types';

/**
 * Utility class for converting API calls to Milky protocol format
 *
 * Since we directly use Milky API names, this converter mainly handles parameter transformation.
 */
export class MilkyAPIConverter {
  /**
   * Convert API action names to Milky protocol endpoints
   * For Milky protocol, we directly use the API names, so this mainly passes through
   * or handles any necessary name transformations.
   *
   * @param action API action name (should already be Milky-style)
   * @returns Milky protocol endpoint name
   */
  static convertActionToMilky(action: string): string {
    // Convert shorthand action names to full Milky protocol endpoint names
    // Milky protocol uses full names like "send_group_message" not "send_group_msg"
    const actionMap: Record<string, string> = {
      send_group_msg: 'send_group_message',
      send_private_msg: 'send_private_message',
      recall_msg: 'recall_message',
      delete_msg: 'delete_message',
    };

    return actionMap[action] || action;
  }

  /**
   * Convert message string or array to OutgoingSegment array
   * Helper function for message conversion
   */
  private static convertMessageToSegments(message: unknown): OutgoingSegment[] | undefined {
    if (typeof message === 'string') {
      return [
        {
          type: 'text',
          data: {
            text: message,
          },
        } as OutgoingSegment,
      ];
    }
    if (Array.isArray(message)) {
      return message as OutgoingSegment[];
    }
    return undefined;
  }

  /**
   * Fields that Milky validates as numeric. Callers may pass numeric strings
   * (config values, upstream protocol payloads, context objects), but Milky's
   * Zod schemas reject string-typed IDs. Coerce them at the final boundary so
   * call sites don't each need to sprinkle `Number(...)`.
   */
  private static readonly NUMERIC_ID_FIELDS = new Set<string>([
    'group_id',
    'user_id',
    'peer_id',
    'target_user_id',
    'operator_id',
    'friend_user_id',
    'message_seq',
    'message_id',
    'sequence',
    'forward_seq',
  ]);

  /** Final-exit guard: coerce numeric-string IDs to numbers before hitting Milky API. */
  private static coerceNumericIds(obj: Record<string, unknown>): Record<string, unknown> {
    for (const key of Object.keys(obj)) {
      if (!MilkyAPIConverter.NUMERIC_ID_FIELDS.has(key)) continue;
      const v = obj[key];
      if (typeof v === 'string' && /^-?\d+$/.test(v)) {
        obj[key] = Number(v);
      }
    }
    return obj;
  }

  /**
   * Convert API parameters to Milky protocol format
   * Uses official types from @saltify/milky-types
   *
   * @param action Milky action name
   * @param params API parameters
   * @returns Milky format parameters
   */
  static convertParamsToMilky(action: string, params: Record<string, unknown>): Record<string, unknown> {
    return MilkyAPIConverter.coerceNumericIds(MilkyAPIConverter.convertParamsToMilkyInternal(action, params));
  }

  private static convertParamsToMilkyInternal(
    action: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (action) {
      // ==================== Message APIs ====================

      case 'send_private_message': {
        const milkyParams: Partial<SendPrivateMessageInput> = {
          user_id: params.user_id as number,
        };

        // For temporary session messages, include group_id if provided
        if (params.group_id !== undefined) {
          (milkyParams as Record<string, unknown>).group_id = params.group_id as number;
        }

        const messageSegments = MilkyAPIConverter.convertMessageToSegments(params.message);
        if (messageSegments) {
          milkyParams.message = messageSegments;
        }

        return milkyParams as Record<string, unknown>;
      }

      case 'send_group_message': {
        const milkyParams: Partial<SendGroupMessageInput> = {
          group_id: params.group_id as number,
        };

        const messageSegments = MilkyAPIConverter.convertMessageToSegments(params.message);
        if (messageSegments) {
          milkyParams.message = messageSegments;
        }

        return milkyParams as Record<string, unknown>;
      }

      case 'recall_group_message': {
        const milkyParams: Partial<RecallGroupMessageInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          message_seq: (params.message_seq || params.message_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'recall_private_message': {
        const milkyParams: Partial<RecallPrivateMessageInput> = {
          user_id: params.user_id as number,
          message_seq: (params.message_seq || params.message_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'delete_message': {
        // Delete message - fallback for backward compatibility
        // Note: This case might be deprecated, use specific recall APIs instead
        return {
          message_seq: (params.message_seq || params.message_id) as number,
        };
      }

      case 'get_message': {
        const milkyParams: Partial<GetMessageInput> = {
          message_scene: params.message_scene as 'friend' | 'group' | 'temp',
          peer_id: (params.peer_id || params.group_id || params.user_id) as number,
          message_seq: (params.message_seq || params.message_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_history_messages': {
        const milkyParams: Partial<GetHistoryMessagesInput> = {
          message_scene: params.message_scene as 'friend' | 'group' | 'temp',
          peer_id: (params.peer_id || params.group_id || params.user_id) as number,
          limit: (params.limit as number) ?? 20,
        };
        if (params.start_message_seq !== undefined) {
          milkyParams.start_message_seq = params.start_message_seq as number;
        }
        return milkyParams as Record<string, unknown>;
      }

      case 'get_resource_temp_url': {
        const milkyParams: Partial<GetResourceTempUrlInput> = {
          resource_id: params.resource_id as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_forwarded_messages': {
        const milkyParams: Partial<GetForwardedMessagesInput> = {
          forward_id: params.forward_id as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'mark_message_as_read': {
        const milkyParams: Partial<MarkMessageAsReadInput> = {
          message_scene: params.message_scene as 'friend' | 'group' | 'temp',
          peer_id: (params.peer_id || params.group_id || params.user_id) as number,
          message_seq: (params.message_seq || params.message_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'send_group_message_reaction': {
        // Milky protocol uses message_seq (number) for reaction API
        // Milky protocol expects reaction (string code like "76") instead of emoji character
        // Ensure message_seq is a number, not a string
        const milkyParams: Record<string, unknown> = {
          group_id: params.group_id as number,
          message_seq: typeof params.message_seq === 'number' ? params.message_seq : Number(params.message_seq),
          reaction: (params.reaction || params.emoji_id) as string, // Milky uses 'reaction' parameter name (表情 ID)
          is_add: (params.is_add as boolean) || true, // Default to true if not specified
        };
        return milkyParams;
      }

      // ==================== System APIs ====================

      case 'get_user_info': {
        // Use GetFriendInfoInput if no_cache is provided, otherwise GetUserProfileInput
        if (params.no_cache !== undefined) {
          const milkyParams: Partial<GetFriendInfoInput> = {
            user_id: (params.user_id || params.peer_id) as number,
            no_cache: params.no_cache as boolean | undefined,
          };
          return milkyParams as Record<string, unknown>;
        }
        // Fallback to GetUserProfileInput (only user_id)
        const milkyParams: Partial<GetUserProfileInput> = {
          user_id: (params.user_id || params.peer_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_user_profile': {
        const milkyParams: Partial<GetUserProfileInput> = {
          user_id: (params.user_id || params.peer_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_friend_info': {
        const milkyParams: Partial<GetFriendInfoInput> = {
          user_id: (params.user_id || params.peer_id) as number,
          no_cache: params.no_cache as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_avatar': {
        const milkyParams: Partial<SetAvatarInput> = {
          uri: params.uri as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_nickname': {
        const milkyParams: Partial<SetNicknameInput> = {
          new_nickname: (params.new_nickname || params.nickname) as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_bio': {
        const milkyParams: Partial<SetBioInput> = {
          new_bio: (params.new_bio || params.bio) as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_cookies': {
        const milkyParams: Partial<GetCookiesInput> = {
          domain: params.domain as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_login_info':
      case 'get_impl_info':
      case 'get_custom_face_url_list':
      case 'get_csrf_token':
      case 'can_send_image':
      case 'can_send_record':
      case 'get_status':
      case 'get_version_info': {
        return {};
      }

      // ==================== Friend APIs ====================

      case 'get_friend_list': {
        const milkyParams: Partial<GetFriendListInput> = {
          no_cache: params.no_cache as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'send_friend_nudge': {
        const milkyParams: Partial<SendFriendNudgeInput> = {
          user_id: params.user_id as number,
          is_self: params.is_self as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'send_profile_like': {
        const milkyParams: Partial<SendProfileLikeInput> = {
          user_id: params.user_id as number,
          count: (params.count as number) ?? 1,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'delete_friend': {
        const milkyParams: Partial<DeleteFriendInput> = {
          user_id: params.user_id as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_friend_requests': {
        const milkyParams: Partial<GetFriendRequestsInput> = {
          limit: (params.limit as number) ?? 20,
          is_filtered: params.is_filtered as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'accept_friend_request': {
        const milkyParams: Partial<AcceptFriendRequestInput> = {
          initiator_uid: params.initiator_uid as string,
          is_filtered: params.is_filtered as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'reject_friend_request': {
        const milkyParams: Partial<RejectFriendRequestInput> = {
          initiator_uid: params.initiator_uid as string,
          is_filtered: params.is_filtered as boolean | undefined,
          reason: params.reason as string | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      // ==================== Group APIs ====================

      case 'get_group_info': {
        const milkyParams: Partial<GetGroupInfoInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          no_cache: params.no_cache as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_list': {
        const milkyParams: Partial<GetGroupListInput> = {
          no_cache: params.no_cache as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_member_list': {
        const milkyParams: Partial<GetGroupMemberListInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          no_cache: params.no_cache as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_member_info': {
        const milkyParams: Partial<GetGroupMemberInfoInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          no_cache: params.no_cache as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_name': {
        const milkyParams: Partial<SetGroupNameInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          new_group_name: params.group_name as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_avatar': {
        const milkyParams: Partial<SetGroupAvatarInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          image_uri: params.image_uri as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_card': {
        const milkyParams: Partial<SetGroupMemberCardInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          card: params.card as string | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_member_special_title': {
        const milkyParams: Partial<SetGroupMemberSpecialTitleInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          special_title: params.special_title as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_admin': {
        const milkyParams: Partial<SetGroupMemberAdminInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          is_set: params.enable as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_ban': {
        const milkyParams: Partial<SetGroupMemberMuteInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          duration: params.duration as number | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_whole_ban': {
        const milkyParams: Partial<SetGroupWholeMuteInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          is_mute: params.enable as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_kick': {
        const milkyParams: Partial<KickGroupMemberInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          reject_add_request: params.reject_add_request as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_leave': {
        const milkyParams: Partial<QuitGroupInput> = {
          group_id: (params.group_id || params.peer_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_announcements': {
        const milkyParams: Partial<GetGroupAnnouncementsInput> = {
          group_id: (params.group_id || params.peer_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'send_group_announcement': {
        const milkyParams: Partial<SendGroupAnnouncementInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          content: params.content as string,
          image_uri: params.image_uri as string | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'delete_group_announcement': {
        const milkyParams: Partial<DeleteGroupAnnouncementInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          announcement_id: params.announcement_id as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_essence_messages': {
        const milkyParams: Partial<GetGroupEssenceMessagesInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          page_index: (params.page_index as number) ?? 0,
          page_size: (params.page_size as number) ?? 20,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_essence_message': {
        const milkyParams: Partial<SetGroupEssenceMessageInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          message_seq: (params.message_seq || params.message_id) as number,
          is_set: (params.is_set as boolean) ?? true,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'send_group_nudge': {
        const milkyParams: Partial<SendGroupNudgeInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_notifications': {
        const milkyParams: Partial<GetGroupNotificationsInput> = {
          is_filtered: params.is_filtered as boolean | undefined,
          limit: (params.limit as number) ?? 20,
        };
        if (params.start_notification_seq !== undefined) {
          milkyParams.start_notification_seq = params.start_notification_seq as number;
        }
        return milkyParams as Record<string, unknown>;
      }

      case 'accept_group_request': {
        const milkyParams: Partial<AcceptGroupRequestInput> = {
          notification_seq: params.notification_seq as number,
          notification_type: params.notification_type as 'join_request' | 'invited_join_request',
          group_id: params.group_id as number,
          is_filtered: params.is_filtered as boolean | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'reject_group_request': {
        const milkyParams: Partial<RejectGroupRequestInput> = {
          notification_seq: params.notification_seq as number,
          notification_type: params.notification_type as 'join_request' | 'invited_join_request',
          group_id: params.group_id as number,
          is_filtered: params.is_filtered as boolean | undefined,
          reason: params.reason as string | undefined,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'accept_group_invitation': {
        const milkyParams: Partial<AcceptGroupInvitationInput> = {
          group_id: params.group_id as number,
          invitation_seq: params.invitation_seq as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'reject_group_invitation': {
        const milkyParams: Partial<RejectGroupInvitationInput> = {
          group_id: params.group_id as number,
          invitation_seq: params.invitation_seq as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      // ==================== File APIs ====================

      case 'upload_group_file': {
        // Pass parameters through as-is (already matches Milky format)
        return params;
      }

      case 'upload_private_file': {
        // Pass parameters through as-is (already matches Milky format)
        return params;
      }

      case 'get_private_file_download_url': {
        const milkyParams: Partial<GetPrivateFileDownloadUrlInput> = {
          user_id: params.user_id as number,
          file_id: params.file_id as string,
          file_hash: params.file_hash as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_file_download_url': {
        const milkyParams: Partial<GetGroupFileDownloadUrlInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          file_id: params.file_id as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_group_files': {
        const milkyParams: Partial<GetGroupFilesInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          parent_folder_id: (params.parent_folder_id as string) ?? '/',
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'move_group_file': {
        const milkyParams: Partial<MoveGroupFileInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          file_id: params.file_id as string,
          parent_folder_id: (params.parent_folder_id as string) ?? '/',
          target_folder_id: (params.target_folder_id as string) ?? '/',
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'rename_group_file': {
        const milkyParams: Partial<RenameGroupFileInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          file_id: params.file_id as string,
          parent_folder_id: (params.parent_folder_id as string) ?? '/',
          new_file_name: params.new_file_name as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'delete_group_file': {
        const milkyParams: Partial<DeleteGroupFileInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          file_id: params.file_id as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'create_group_folder': {
        const milkyParams: Partial<CreateGroupFolderInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          folder_name: params.folder_name as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'rename_group_folder': {
        const milkyParams: Partial<RenameGroupFolderInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          folder_id: params.folder_id as string,
          new_folder_name: params.new_folder_name as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'delete_group_folder': {
        const milkyParams: Partial<DeleteGroupFolderInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          folder_id: params.folder_id as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'get_image': {
        return {
          file: params.file as string,
        };
      }

      default: {
        // For unknown actions, pass parameters through as-is
        // This allows for future API extensions without modifying this converter
        return params;
      }
    }
  }
}
