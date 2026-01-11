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
 * Conversion flow:
 * 1. Application layer calls unified API interface (OneBot11-style naming like 'send_private_msg')
 * 2. APIClient routes to MilkyAdapter
 * 3. MilkyAdapter receives unified action/params and uses this converter
 * 4. This converter transforms to Milky native format (like 'send_private_message')
 * 5. MilkyAdapter sends HTTP request to Milky server
 */
export class MilkyAPIConverter {
  /**
   * Convert unified API action names (OneBot11-style) to Milky protocol endpoints
   *
   * @param action Unified API action name (OneBot11-style, e.g., 'send_private_msg')
   * @returns Milky protocol endpoint name (e.g., 'send_private_message')
   */
  static convertActionToMilky(action: string): string {
    const actionMap: Record<string, string> = {
      // Message APIs
      send_private_msg: 'send_private_message',
      send_group_msg: 'send_group_message',
      delete_msg: 'delete_message',
      recall_msg: 'recall_message',

      // User/Group Info APIs
      get_login_info: 'get_login_info',
      get_user_info: 'get_user_info',
      get_friend_list: 'get_friend_list',
      get_group_list: 'get_group_list',
      get_group_info: 'get_group_info',
      get_group_member_list: 'get_group_member_list',
      get_group_member_info: 'get_group_member_info',

      // Group Management APIs
      set_group_kick: 'set_group_kick',
      set_group_ban: 'set_group_ban',
      set_group_whole_ban: 'set_group_whole_ban',
      set_group_admin: 'set_group_admin',
      set_group_card: 'set_group_card',
      set_group_name: 'set_group_name',
      set_group_leave: 'set_group_leave',

      // File APIs
      get_image: 'get_image',
      can_send_image: 'can_send_image',
      can_send_record: 'can_send_record',

      // Status APIs
      get_status: 'get_status',
      get_version_info: 'get_version_info',
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
   * Convert unified API parameters (OneBot11-style) to Milky protocol format
   * Uses official types from @saltify/milky-types
   * Improved with switch case structure for better maintainability
   *
   * @param action Milky action name (already converted by convertActionToMilky)
   * @param params Unified API parameters (OneBot11-style, e.g., { user_id, message: string })
   * @returns Milky format parameters (e.g., { user_id, message: OutgoingSegment[] })
   */
  static convertParamsToMilky(action: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (action) {
      case 'send_private_message': {
        const milkyParams: Partial<SendPrivateMessageInput> = {
          user_id: (params.user_id || params.peer_id) as number,
        };

        const messageSegments = MilkyAPIConverter.convertMessageToSegments(params.message);
        if (messageSegments) {
          milkyParams.message = messageSegments;
        }

        return milkyParams as Record<string, unknown>;
      }

      case 'send_group_message': {
        const milkyParams: Partial<SendGroupMessageInput> = {
          group_id: (params.group_id || params.peer_id) as number,
        };

        const messageSegments = MilkyAPIConverter.convertMessageToSegments(params.message);
        if (messageSegments) {
          milkyParams.message = messageSegments;
        }

        return milkyParams as Record<string, unknown>;
      }

      case 'delete_message':
      case 'recall_message': {
        // Milky protocol uses message_seq instead of message_id
        // And requires user_id for private messages or group_id for group messages
        // Try to determine message type from params
        if (params.group_id || params.peer_id) {
          // Group message recall
          const milkyParams: Partial<RecallGroupMessageInput> = {
            group_id: (params.group_id || params.peer_id) as number,
            message_seq: (params.message_seq || params.message_id) as number,
          };
          return milkyParams as Record<string, unknown>;
        } else if (params.user_id) {
          // Private message recall
          const milkyParams: Partial<RecallPrivateMessageInput> = {
            user_id: params.user_id as number,
            message_seq: (params.message_seq || params.message_id) as number,
          };
          return milkyParams as Record<string, unknown>;
        }
        // Fallback: if we can't determine, assume it's a message_seq
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
        // For unknown actions, pass through with parameter name conversion
        const converted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(params)) {
          // Convert common OneBot11 parameter names to Milky
          // Note: Milky uses peer_id for both user_id and group_id in some contexts
          if (key === 'user_id' && !('peer_id' in params) && !('user_id' in converted)) {
            converted.user_id = value;
          } else if (key === 'group_id' && !('peer_id' in params) && !('group_id' in converted)) {
            converted.group_id = value;
          } else {
            converted[key] = value;
          }
        }
        return converted;
      }
    }
  }
}
