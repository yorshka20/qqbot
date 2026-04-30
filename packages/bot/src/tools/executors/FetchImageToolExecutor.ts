// Fetch image tool executor - retrieves historical images by message ID for AI vision analysis

import { inject, injectable } from 'tsyringe';
import type { ContentPart } from '@/ai/types';
import { extractImagesFromSegmentsAsync, normalizeVisionImages } from '@/ai/utils/imageUtils';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { Message } from '@/database/models/types';
import type { MessageSegment } from '@/message/types';
import { logger } from '@/utils/logger';
import { Tool } from '../decorators';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { BaseToolExecutor } from './BaseToolExecutor';

/**
 * Fetch image tool executor.
 * Retrieves an image from conversation history by its identifier (messageId:imageIndex)
 * and returns it as base64 ContentPart for AI vision analysis.
 */
@Tool({
  name: 'fetch_image',
  description:
    '获取历史消息中的图片内容，返回给你进行视觉分析。使用消息中 <image_segment> 标签的 id 属性来指定要获取的图片。',
  executor: 'fetch_image',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
  parameters: {
    image_id: {
      type: 'string',
      required: true,
      description:
        '图片标识符，格式为 "messageId:imageIndex"，来自历史消息中 <image_segment id="..." /> 标签的 id 属性',
    },
  },
  examples: ['帮我看看这张图片是什么', '分析一下刚才发的那张图', '识别历史消息中的图片内容'],
  triggerKeywords: ['看图', '图片识别', '分析图片', '图片内容', '看看图片'],
  whenToUse:
    '当你需要查看历史消息中某张图片的具体内容时调用。前提：消息中有 <image_segment id="..." /> 标签。注意：当前消息附带的图片已经自动展示给你，无需调用此工具；此工具仅用于获取历史消息中你尚未看到的图片。',
})
@injectable()
export class FetchImageToolExecutor extends BaseToolExecutor {
  name = 'fetch_image';

  constructor(
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
  ) {
    super();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const imageId = call.parameters?.image_id as string | undefined;
    if (!imageId) {
      return this.error('请提供图片标识符 (image_id)', 'Missing required parameter: image_id');
    }

    // Parse image_id: "messageId:imageIndex"
    const colonIndex = imageId.lastIndexOf(':');
    if (colonIndex === -1) {
      return this.error(
        `无效的图片标识符格式: ${imageId}。应为 "messageId:imageIndex"`,
        `Invalid image_id format: ${imageId}`,
      );
    }

    const messageId = imageId.substring(0, colonIndex);
    const imageIndex = parseInt(imageId.substring(colonIndex + 1), 10);
    if (Number.isNaN(imageIndex) || imageIndex < 0) {
      return this.error(
        `无效的图片索引: ${imageId.substring(colonIndex + 1)}`,
        `Invalid image index in image_id: ${imageId}`,
      );
    }

    // Look up message in database
    const adapter = this.databaseManager.getAdapter();
    if (!adapter?.isConnected()) {
      return this.error('数据库未连接', 'Database not connected');
    }

    const messagesModel = adapter.getModel('messages');
    const message: Message | null = await messagesModel.findById(messageId);
    if (!message) {
      return this.error(`未找到消息: ${messageId}`, `Message not found: ${messageId}`);
    }

    // Parse rawContent to get segments.
    // SQLite adapter auto-parses JSON fields, so rawContent may already be an array.
    if (!message.rawContent) {
      return this.error('该消息没有保存原始内容（无图片数据）', 'Message has no rawContent');
    }

    let segments: MessageSegment[];
    if (Array.isArray(message.rawContent)) {
      segments = message.rawContent as MessageSegment[];
    } else if (typeof message.rawContent === 'string') {
      try {
        const parsed = JSON.parse(message.rawContent);
        if (!Array.isArray(parsed)) {
          return this.error('消息原始内容格式无效', 'rawContent is not an array');
        }
        segments = parsed as MessageSegment[];
      } catch {
        return this.error('消息原始内容解析失败', 'Failed to parse rawContent');
      }
    } else {
      return this.error('消息原始内容格式无效', 'rawContent is not a string or array');
    }

    // Count image segments and find the target
    const imageSegments = segments.filter((s) => s.type === 'image');
    if (imageSegments.length === 0) {
      return this.error('该消息中没有图片', 'No image segments in message');
    }
    if (imageIndex >= imageSegments.length) {
      return this.error(
        `图片索引 ${imageIndex} 超出范围，该消息共有 ${imageSegments.length} 张图片`,
        `Image index ${imageIndex} out of range (${imageSegments.length} images)`,
      );
    }

    // Extract only the target image segment
    const targetSegment = imageSegments[imageIndex];

    // Try to resolve resource_id via MessageAPI when hookContext provides message context
    const hookContext = context.hookContext;
    const getResourceUrl = hookContext?.message
      ? (resourceId: string) => this.messageAPI.getResourceTempUrl(resourceId, hookContext.message)
      : undefined;

    try {
      const visionImages = await extractImagesFromSegmentsAsync([targetSegment], getResourceUrl);
      if (visionImages.length === 0) {
        return this.error('无法提取图片数据（URL 和 resource_id 均不可用）', 'Failed to extract image from segment');
      }

      // Normalize to base64
      const normalized = await normalizeVisionImages(visionImages, {
        timeout: 30000,
        maxSize: 10 * 1024 * 1024,
      });

      const base64 = normalized[0]?.base64;
      if (normalized.length === 0 || !base64) {
        return this.error('图片下载或转换失败', 'Failed to normalize image to base64');
      }

      const mime = normalized[0].mimeType || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${base64}`;

      logger.info(
        `[FetchImageToolExecutor] Successfully fetched image | messageId=${messageId} index=${imageIndex} size=${base64.length} bytes`,
      );

      // Build ContentPart[] for vision injection
      const contentParts: ContentPart[] = [{ type: 'image_url', image_url: { url: dataUrl } }];

      return {
        success: true,
        reply: `已获取消息 ${messageId} 的第 ${imageIndex + 1} 张图片`,
        data: {
          messageId,
          imageIndex,
          mimeType: mime,
          sizeBytes: base64.length,
        },
        contentParts,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[FetchImageToolExecutor] Failed to fetch image: ${errMsg}`);
      return this.error(`图片获取失败: ${errMsg}`, `Image fetch failed: ${errMsg}`);
    }
  }
}
