// File API method wrappers for Milky protocol

import type { CommandContext } from '@/command/types';
import { ProtocolName } from '@/core/config/protocol';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';
import type { APIClient } from '../APIClient';

export interface UploadFileResult {
  file_id: string; // File ID returned by Milky protocol
}

export class FileAPI {
  constructor(private apiClient: APIClient) { }

  /**
   * Extract protocol from context (CommandContext or NormalizedMessageEvent)
   * @param context - CommandContext or NormalizedMessageEvent
   * @returns Protocol name
   * @throws Error if protocol is not found in context
   */
  private extractProtocol(context: CommandContext | NormalizedMessageEvent): ProtocolName {
    if ('metadata' in context && context.metadata?.protocol) {
      // CommandContext case
      return context.metadata.protocol;
    } else if ('protocol' in context && context.protocol) {
      // NormalizedMessageEvent case
      return context.protocol;
    } else {
      throw new Error('Protocol is required but not found in context');
    }
  }

  /**
   * Upload file to group using Milky protocol
   * @param groupId - Group ID
   * @param fileUri - File URI (file://, http(s)://, or base64:// format)
   * @param fileName - File name
   * @param protocol - Protocol name (default: milky)
   * @param timeout - Optional timeout in milliseconds (default: 30000)
   * @returns File ID
   */
  async uploadGroupFile(
    groupId: number,
    fileUri: string,
    fileName: string,
    protocol: ProtocolName = 'milky',
    timeout: number = 30000,
  ): Promise<string> {
    const result = await this.apiClient.call<UploadFileResult>(
      'upload_group_file',
      {
        group_id: groupId,
        file_uri: fileUri,
        file_name: fileName,
        parent_folder_id: '/', // Default to root folder
      },
      protocol,
      timeout,
    );

    if (!result.file_id) {
      throw new Error('File upload failed: file_id not returned');
    }

    logger.info(`[FileAPI] Uploaded file to group ${groupId}: ${fileName} (file_id: ${result.file_id})`);
    return result.file_id;
  }

  /**
   * Upload file to private chat using Milky protocol
   * @param userId - User ID
   * @param fileUri - File URI (file://, http(s)://, or base64:// format)
   * @param fileName - File name
   * @param protocol - Protocol name (default: milky)
   * @param timeout - Optional timeout in milliseconds (default: 30000)
   * @returns File ID
   */
  async uploadPrivateFile(
    userId: number,
    fileUri: string,
    fileName: string,
    protocol: ProtocolName = 'milky',
    timeout: number = 30000,
  ): Promise<string> {
    const result = await this.apiClient.call<UploadFileResult>(
      'upload_private_file',
      {
        user_id: userId,
        file_uri: fileUri,
        file_name: fileName,
      },
      protocol,
      timeout,
    );

    if (!result.file_id) {
      throw new Error('File upload failed: file_id not returned');
    }

    logger.info(`[FileAPI] Uploaded file to user ${userId}: ${fileName} (file_id: ${result.file_id})`);
    return result.file_id;
  }

  /**
   * Upload file from context (CommandContext or NormalizedMessageEvent)
   * Automatically determines whether to upload to group or private chat
   * @param fileUri - File URI (file://, http(s)://, or base64:// format)
   * @param fileName - File name
   * @param context - CommandContext or NormalizedMessageEvent
   * @param timeout - Optional timeout in milliseconds (default: 30000)
   * @returns File ID
   */
  async uploadFromContext(
    fileUri: string,
    fileName: string,
    context: CommandContext | NormalizedMessageEvent,
    timeout: number = 30000,
  ): Promise<string> {
    const protocol = this.extractProtocol(context);
    const userId = context.userId;
    const groupId = context.groupId;
    const messageType = context.messageType;

    // Determine upload target based on message type
    if (messageType === 'private' || !groupId) {
      return this.uploadPrivateFile(userId, fileUri, fileName, protocol, timeout);
    } else {
      return this.uploadGroupFile(groupId, fileUri, fileName, protocol, timeout);
    }
  }
}
