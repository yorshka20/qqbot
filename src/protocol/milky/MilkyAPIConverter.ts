// Milky API converter utilities
// Converts unified API interface (OneBot11-style naming) to Milky protocol native format

import type {
  GetFriendInfoInput,
  GetFriendListInput,
  GetGroupInfoInput,
  GetGroupListInput,
  GetGroupMemberInfoInput,
  GetGroupMemberListInput,
  GetUserProfileInput,
  KickGroupMemberInput,
  OutgoingSegment,
  QuitGroupInput,
  RecallGroupMessageInput,
  RecallPrivateMessageInput,
  SendGroupMessageInput,
  SendPrivateMessageInput,
  SetGroupMemberAdminInput,
  SetGroupMemberCardInput,
  SetGroupMemberMuteInput,
  SetGroupNameInput,
  SetGroupWholeMuteInput,
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
   * Convert API parameters to Milky protocol format
   * Uses official types from @saltify/milky-types
   *
   * @param action Milky action name
   * @param params API parameters
   * @returns Milky format parameters
   */
  static convertParamsToMilky(action: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (action) {
      // Currently used APIs in the project - implementations are above

      // Future APIs - defined for completeness but not currently used
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
        // Group message recall - requires group_id and message_seq
        const milkyParams: Partial<RecallGroupMessageInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          message_seq: (params.message_seq || params.message_id) as number,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'recall_private_message': {
        // Private message recall - requires user_id and message_seq
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

      case 'get_group_info': {
        const milkyParams: Partial<GetGroupInfoInput> = {
          group_id: (params.group_id || params.peer_id) as number,
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

      case 'set_group_kick': {
        const milkyParams: Partial<KickGroupMemberInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          reject_add_request: params.reject_add_request as boolean | undefined,
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

      case 'set_group_admin': {
        const milkyParams: Partial<SetGroupMemberAdminInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          user_id: params.user_id as number,
          is_set: params.enable as boolean | undefined,
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

      case 'set_group_name': {
        const milkyParams: Partial<SetGroupNameInput> = {
          group_id: (params.group_id || params.peer_id) as number,
          new_group_name: params.group_name as string,
        };
        return milkyParams as Record<string, unknown>;
      }

      case 'set_group_leave': {
        const milkyParams: Partial<QuitGroupInput> = {
          group_id: (params.group_id || params.peer_id) as number,
        };
        // Note: QuitGroupInput doesn't have is_dismiss, so we ignore it
        return milkyParams as Record<string, unknown>;
      }

      case 'get_image': {
        return {
          file: params.file as string,
        };
      }

      case 'get_friend_list': {
        const milkyParams: Partial<GetFriendListInput> = {
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

      case 'get_login_info':
      case 'can_send_image':
      case 'can_send_record':
      case 'get_status':
      case 'get_version_info': {
        // These actions typically don't require parameters
        return {};
      }

      default: {
        // For unknown actions, pass parameters through as-is
        // This allows for future API extensions without modifying this converter
        return params;
      }
    }
  }
}
