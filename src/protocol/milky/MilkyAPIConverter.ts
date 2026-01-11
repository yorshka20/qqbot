// Milky API converter utilities
// Converts unified API interface (OneBot11-style naming) to Milky protocol native format

import type {
  OutgoingSegment,
  SendGroupMessageInput,
  SendPrivateMessageInput,
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
      send_private_msg: 'send_private_message',
      send_group_msg: 'send_group_message',
      get_login_info: 'get_login_info',
      // Add more mappings as needed
    };

    return actionMap[action] || action;
  }

  /**
   * Convert unified API parameters (OneBot11-style) to Milky protocol format
   * Uses official types from @saltify/milky-types
   *
   * @param action Milky action name (already converted by convertActionToMilky)
   * @param params Unified API parameters (OneBot11-style, e.g., { user_id, message: string })
   * @returns Milky format parameters (e.g., { user_id, message: OutgoingSegment[] })
   */
  static convertParamsToMilky(
    action: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    // Handle send_private_message - use SendPrivateMessageInput type
    if (action === 'send_private_message') {
      const milkyParams: Partial<SendPrivateMessageInput> = {
        user_id: (params.user_id || params.peer_id) as number,
      };

      // Convert message to segments if it's a string
      if (typeof params.message === 'string') {
        milkyParams.message = [
          {
            type: 'text',
            data: {
              text: params.message,
            },
          } as OutgoingSegment,
        ];
      } else if (Array.isArray(params.message)) {
        // Already segments format - validate as OutgoingSegment[]
        milkyParams.message = params.message as OutgoingSegment[];
      }

      return milkyParams as Record<string, unknown>;
    }

    // Handle send_group_message - use SendGroupMessageInput type
    if (action === 'send_group_message') {
      const milkyParams: Partial<SendGroupMessageInput> = {
        group_id: (params.group_id || params.peer_id) as number,
      };

      // Convert message to segments if it's a string
      if (typeof params.message === 'string') {
        milkyParams.message = [
          {
            type: 'text',
            data: {
              text: params.message,
            },
          } as OutgoingSegment,
        ];
      } else if (Array.isArray(params.message)) {
        // Already segments format - validate as OutgoingSegment[]
        milkyParams.message = params.message as OutgoingSegment[];
      }

      return milkyParams as Record<string, unknown>;
    }

    // For other actions, pass through with parameter name conversion
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      // Convert common OneBot11 parameter names to Milky
      if (key === 'user_id' && !('peer_id' in params)) {
        converted.peer_id = value;
      } else if (key === 'group_id' && !('peer_id' in params)) {
        converted.peer_id = value;
      } else {
        converted[key] = value;
      }
    }

    return converted;
  }
}
