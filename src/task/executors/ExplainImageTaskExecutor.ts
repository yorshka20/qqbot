// Explain image task executor - describes image content via vision AI and feeds result into LLM reply flow

import type { AIService } from '@/ai/AIService';
import type { VisionImage } from '@/ai/capabilities/types';
import { extractImagesFromMessageAndReply, extractImagesFromSegmentsAsync } from '@/ai/utils/imageUtils';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { MessageSegment } from '@/message/types';
import { DITokens } from '@/core/DITokens';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskResult } from '../types';
import { BaseTaskExecutor } from './BaseTaskExecutor';

/**
 * Explain Image task executor (not registered: reply flow uses vision provider when message has images).
 * Kept for reference; uses AIService.describeImages when invoked.
 */
@TaskDefinition({
  name: 'explainImage',
  description: '使用视觉AI分析并描述消息中的图片内容',
  executor: 'explainImage',
  parameters: {},
  examples: [
    '这张图是什么？',
    '帮我看看这个图片',
    '描述一下这张照片',
    '这个截图里说的什么',
    '你能看懂这张图吗',
    '分析一下这个图',
  ],
  triggerKeywords: ['图', '图片', '照片', '截图', '图像', '看看', '看一下', '描述图', '分析图'],
  whenToUse:
    '当用户发送了图片并询问图片内容，或明确要求分析/描述图片时使用。例如用户说"这是什么图"、"帮我看看这张图"等。',
})
@injectable()
export class ExplainImageTaskExecutor extends BaseTaskExecutor {
  name = 'explainImage';

  constructor(
    @inject(DITokens.AI_SERVICE) private aiService: AIService,
    @inject(DITokens.MESSAGE_API) private messageAPI: MessageAPI,
    @inject(DITokens.DATABASE_MANAGER) private databaseManager: DatabaseManager,
  ) {
    super();
  }

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    const hookContext = context.hookContext;
    if (!hookContext) {
      logger.warn('[ExplainImageTaskExecutor] HookContext not available, cannot extract images');
      return this.error('无法获取消息上下文', 'HookContext not found in TaskExecutionContext');
    }

    const sessionId = hookContext.metadata.get('sessionId') as string | undefined;
    const userMessage = hookContext.message.message || '（无）';

    // Extract images: prefer segments passed in task parameters (from TaskSystem when auto-injecting)
    // to avoid context/message propagation issues. Fall back to extractImagesFromMessageAndReply.
    let images: VisionImage[] = [];
    try {
      const paramSegments = task.parameters?.imageSegments as MessageSegment[] | undefined;
      if (Array.isArray(paramSegments) && paramSegments.length > 0) {
        const getResourceUrl = (resourceId: string) =>
          this.messageAPI.getResourceTempUrl(resourceId, hookContext.message);
        images = await extractImagesFromSegmentsAsync(paramSegments, getResourceUrl);
        logger.debug(`[ExplainImageTaskExecutor] Extracted ${images.length} image(s) from task parameters`);
      } else {
        images = await extractImagesFromMessageAndReply(hookContext.message, this.messageAPI, this.databaseManager);
      }
    } catch (error) {
      logger.warn(
        '[ExplainImageTaskExecutor] Failed to extract images:',
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!images.length) {
      logger.info('[ExplainImageTaskExecutor] No images found in message, returning empty result');
      return this.success('', { hasImages: false });
    }

    logger.info(`[ExplainImageTaskExecutor] Describing ${images.length} image(s) from message`);

    const description = await this.aiService.explainImages(images, userMessage, sessionId);
    if (!description) {
      logger.warn('[ExplainImageTaskExecutor] Image description returned empty');
      return this.success('', { hasImages: true, descriptionEmpty: true });
    }

    logger.info(`[ExplainImageTaskExecutor] Image description generated (${description.length} chars)`);
    return this.success(description, { hasImages: true, imageCount: images.length });
  }
}
