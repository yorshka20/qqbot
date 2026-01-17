/**
 * Message sender service
 * Generic service for sending various types of responses as messages
 */

import { ImageGenerationResponse } from '@/ai';
import { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import { MessageBuilder } from '@/message/MessageBuilder';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import type { CommandContext } from '../types';

/**
 * Generic response types that can be sent as messages
 */
export type SendableResponse =
  | ImageGenerationResponse
  | { text?: string; record?: { url?: string; base64?: string } }
  | string
  | MessageBuilder;

/**
 * Service for sending various types of responses as messages
 * Handles building message segments from different response types and sending via API client
 */
@injectable()
export class MessageSender {
  private messageAPI: MessageAPI;

  constructor(@inject(DITokens.API_CLIENT) private apiClient: any) {
    // Create MessageAPI instance from APIClient
    this.messageAPI = new MessageAPI(this.apiClient);
  }

  /**
   * Build message from various response types
   * @param response - Response to convert to message
   * @param loggerPrefix - Prefix for logger messages
   * @returns MessageBuilder instance
   */
  buildMessage(response: SendableResponse, loggerPrefix?: string): MessageBuilder {
    const prefix = loggerPrefix || '[MessageSender]';
    // If already a MessageBuilder, return it
    if (response instanceof MessageBuilder) {
      return response;
    }

    const messageBuilder = new MessageBuilder();

    // Handle string response
    if (typeof response === 'string') {
      messageBuilder.text(response);
      return messageBuilder;
    }

    // Handle ImageGenerationResponse
    if ('images' in response && Array.isArray(response.images)) {
      const imgResponse = response as ImageGenerationResponse;

      // Add text message from provider if available (may contain error message)
      if (imgResponse.text) {
        messageBuilder.text(imgResponse.text);
      }

      // Add each image
      // File paths are already converted to URLs by ImageGenerationService
      for (const image of imgResponse.images) {
        if (image.url) {
          // Prefer URL over base64 for better performance
          messageBuilder.image({ url: image.url });
        } else if (image.base64) {
          // Fallback to base64 if URL is not available
          // Milky protocol supports base64 data in the 'data' field
          messageBuilder.image({ data: image.base64 });
        } else {
          logger.warn(`${loggerPrefix} Image has no url or base64 field: ${JSON.stringify(image)}`);
        }
      }

      return messageBuilder;
    }

    // Handle record/audio response
    if ('record' in response) {
      const mediaResponse = response as { text?: string; record?: { url?: string; base64?: string } };

      if (mediaResponse.text) {
        messageBuilder.text(mediaResponse.text);
      }

      if (mediaResponse.record) {
        if (mediaResponse.record.url) {
          messageBuilder.record({ url: mediaResponse.record.url });
        } else if (mediaResponse.record.base64) {
          messageBuilder.record({ data: mediaResponse.record.base64 });
        } else {
          logger.warn(`${loggerPrefix} Record has no url or base64 field: ${JSON.stringify(mediaResponse.record)}`);
        }
      }

      return messageBuilder;
    }

    // Handle text-only response
    if ('text' in response && response.text) {
      messageBuilder.text(response.text);
      return messageBuilder;
    }

    // Fallback: log warning and return empty message
    logger.warn(`${prefix} Unknown response type: ${JSON.stringify(response)}`);
    return messageBuilder;
  }

  /**
   * Send message segments
   * @param messageSegments - Message segments to send
   * @param context - Command context with user/group info and message type
   * @param timeout - Optional timeout in milliseconds (default: 30000)
   */
  async send(messageSegments: MessageSegment[], context: CommandContext, timeout: number = 30000): Promise<void> {
    // Use MessageAPI to send message from context
    // MessageAPI automatically extracts protocol, userId, groupId, and handles message type logic
    await this.messageAPI.sendFromContext(messageSegments, context, timeout);
  }
}
