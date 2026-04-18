// Utility functions for file upload to Milky protocol

import type { FileAPI } from '@/api/methods/FileAPI';
import type { CommandContext } from '@/command/types';
import type { NormalizedMessageEvent } from '@/events/types';
import { logger } from '@/utils/logger';

/**
 * Upload file buffer to Milky protocol and get file_id
 * This is a generic utility function that can be used by any command handler
 *
 * @param fileAPI - FileAPI instance
 * @param fileBuffer - File buffer to upload
 * @param fileName - File name
 * @param context - CommandContext or NormalizedMessageEvent
 * @param timeout - Optional timeout in milliseconds (default: 30000)
 * @returns File ID from Milky protocol
 */
export async function uploadFileBuffer(
  fileAPI: FileAPI,
  fileBuffer: Buffer,
  fileName: string,
  context: CommandContext | NormalizedMessageEvent,
  timeout: number = 30000,
): Promise<string> {
  // Convert buffer to base64:// URI format (Milky protocol supports this)
  const base64Data = fileBuffer.toString('base64');
  const fileUri = `base64://${base64Data}`;

  logger.debug(`[fileUpload] Uploading file: ${fileName} (size: ${fileBuffer.length} bytes)`);

  // Upload file using FileAPI
  const fileId = await fileAPI.uploadFromContext(fileUri, fileName, context, timeout);

  logger.info(`[fileUpload] File uploaded successfully: ${fileName} (file_id: ${fileId})`);
  return fileId;
}

/**
 * Upload file from local path to Milky protocol and get file_id
 *
 * @param fileAPI - FileAPI instance
 * @param filePath - Local file path
 * @param fileName - File name (optional, will extract from path if not provided)
 * @param context - CommandContext or NormalizedMessageEvent
 * @param timeout - Optional timeout in milliseconds (default: 30000)
 * @returns File ID from Milky protocol
 */
export async function uploadFilePath(
  fileAPI: FileAPI,
  filePath: string,
  fileName: string | undefined,
  context: CommandContext | NormalizedMessageEvent,
  timeout: number = 30000,
): Promise<string> {
  // Use file:// URI format
  const fileUri = `file://${filePath}`;
  const finalFileName = fileName || filePath.split(/[/\\]/).pop() || 'file';

  logger.debug(`[fileUpload] Uploading file from path: ${filePath}`);

  // Upload file using FileAPI
  const fileId = await fileAPI.uploadFromContext(fileUri, finalFileName, context, timeout);

  logger.info(`[fileUpload] File uploaded successfully: ${finalFileName} (file_id: ${fileId})`);
  return fileId;
}

/**
 * Upload file from URL to Milky protocol and get file_id
 *
 * @param fileAPI - FileAPI instance
 * @param fileUrl - HTTP/HTTPS URL of the file
 * @param fileName - File name
 * @param context - CommandContext or NormalizedMessageEvent
 * @param timeout - Optional timeout in milliseconds (default: 30000)
 * @returns File ID from Milky protocol
 */
export async function uploadFileUrl(
  fileAPI: FileAPI,
  fileUrl: string,
  fileName: string,
  context: CommandContext | NormalizedMessageEvent,
  timeout: number = 30000,
): Promise<string> {
  logger.debug(`[fileUpload] Uploading file from URL: ${fileUrl}`);

  // Upload file using FileAPI (Milky protocol supports http(s):// URIs)
  const fileId = await fileAPI.uploadFromContext(fileUrl, fileName, context, timeout);

  logger.info(`[fileUpload] File uploaded successfully: ${fileName} (file_id: ${fileId})`);
  return fileId;
}
