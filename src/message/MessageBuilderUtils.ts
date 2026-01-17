/**
 * Message builder utilities
 * Helper functions for building messages from various response types
 */

import type { ImageGenerationResponse } from '@/ai';
import { logger } from '@/utils/logger';
import { MessageBuilder } from './MessageBuilder';

/**
 * Generic response types that can be converted to messages
 */
export type SendableResponse =
  | ImageGenerationResponse
  | { text?: string; record?: { url?: string; base64?: string } }
  | string
  | MessageBuilder;

/**
 * Build message from various response types
 * @param response - Response to convert to message
 * @param loggerPrefix - Prefix for logger messages
 * @returns MessageBuilder instance
 */
export function buildMessageFromResponse(
  response: SendableResponse,
  loggerPrefix?: string,
): MessageBuilder {
  const prefix = loggerPrefix || '[MessageBuilderUtils]';
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
