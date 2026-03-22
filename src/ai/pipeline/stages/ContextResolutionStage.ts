// Context resolution stage — resolve referenced messages, extract images, build task summaries.

import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { DatabaseManager } from '@/database/DatabaseManager';
import type { ToolResult } from '@/tools/types';
import { logger } from '@/utils/logger';
import { extractImagesFromMessageAndReply, getReplyMessageIdFromMessage } from '../../utils/imageUtils';
import type { ReplyPipelineContext } from '../ReplyPipelineContext';
import type { ReplyStage } from '../types';

/**
 * Pipeline stage 2: context resolution.
 * Resolves the referenced (quoted) message for text injection, extracts images from
 * both the current message and the referenced message for vision provider use,
 * and builds a summary of task execution results.
 */
export class ContextResolutionStage implements ReplyStage {
  readonly name = 'context-resolution';

  constructor(
    private messageAPI: MessageAPI,
    private databaseManager: DatabaseManager,
  ) {}

  async execute(ctx: ReplyPipelineContext): Promise<void> {
    const { hookContext, taskResults } = ctx;

    // Extract tool result images
    ctx.taskResultImages = this.extractToolResultImages(taskResults);

    // Resolve referenced (quoted) message for text injection and image extraction
    const replyMessageId = getReplyMessageIdFromMessage(hookContext.message);
    if (replyMessageId !== null) {
      try {
        ctx.referencedMessage = await this.messageAPI.getMessageFromContext(
          replyMessageId,
          hookContext.message,
          this.databaseManager,
        );
        const refText = (ctx.referencedMessage.message ?? '').trim();
        const hasImage = ctx.referencedMessage.segments?.some((s) => s.type === 'image');
        const referencedText = refText + (hasImage ? '（含图片）' : '');
        if (referencedText) {
          ctx.userMessageOverride = `被引用的消息：${referencedText}\n\n当前问题：${hookContext.message.message ?? ''}`;
          logger.debug(
            `[ContextResolutionStage] Injected referenced message into prompt | messageSeq=${replyMessageId} | refLength=${referencedText.length}`,
          );
        }
      } catch (err) {
        ctx.referencedMessage = null;
        logger.debug(
          `[ContextResolutionStage] Referenced message not found, skipping text injection | messageSeq=${replyMessageId} | error=${err instanceof Error ? err.message : 'Unknown'}`,
        );
      }
    }

    // Extract images from user message (and referenced reply message) for vision provider
    try {
      ctx.messageImages = await extractImagesFromMessageAndReply(
        hookContext.message,
        this.messageAPI,
        this.databaseManager,
        ctx.referencedMessage,
      );
    } catch (err) {
      logger.warn('[ContextResolutionStage] Failed to extract message images, continuing without vision:', err);
    }

    // Build task results summary
    ctx.taskResultsSummary = this.buildToolResultsSummary(taskResults);
  }

  private extractToolResultImages(taskResults: Map<string, ToolResult>): string[] {
    const images: string[] = [];
    for (const result of taskResults.values()) {
      if (result.success && result.data?.imageBase64 && typeof result.data.imageBase64 === 'string') {
        images.push(result.data.imageBase64);
      }
    }
    return images;
  }

  private buildToolResultsSummary(taskResults: Map<string, ToolResult>): string {
    const summaries: string[] = [];
    for (const [taskType, result] of taskResults.entries()) {
      if (result.success) {
        summaries.push(`Task ${taskType}: ${result.reply}`);
      } else {
        summaries.push(`Task ${taskType}: Execution failed - ${result.error}`);
      }
    }
    return summaries.join('\n\n');
  }
}
