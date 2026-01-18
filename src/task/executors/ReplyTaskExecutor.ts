// Reply task executor - handles simple reply tasks

import type { AIService } from '@/ai/AIService';
import { getReply, getReplyContent } from '@/context/HookContextHelpers';
import { DITokens } from '@/core/DITokens';
import { logger } from '@/utils/logger';
import { inject, injectable } from 'tsyringe';
import { TaskDefinition } from '../decorators';
import type { Task, TaskExecutionContext, TaskExecutor, TaskResult } from '../types';

/**
 * Reply task executor
 * Generates AI reply using AIService
 */
@TaskDefinition({
  name: 'reply',
  description: 'Generate AI reply for user message',
  executor: 'reply',
  examples: [
    '你好',
    '今天天气不错',
    '帮我写一首诗',
  ],
  whenToUse: 'This is the default task for generating AI responses. Use this when no other specific task type matches the user request.',
})
@injectable()
export class ReplyTaskExecutor implements TaskExecutor {
  name = 'reply';

  constructor(@inject(DITokens.AI_SERVICE) private aiService: AIService) { }

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    logger.debug('[ReplyTaskExecutor] Executing reply task');

    // Get HookContext from context (first-class field, type-safe)
    const hookContext = context.hookContext;
    if (!hookContext) {
      logger.warn('[ReplyTaskExecutor] HookContext not found in context, cannot generate reply');
      return {
        success: false,
        reply: 'Reply generation failed: Missing required context information',
        error: 'HookContext not found in context',
      };
    }

    try {
      // Get task results from context (first-class field, type-safe)
      // If not available, use empty Map (for simple reply scenario)
      const taskResults = context.taskResults || new Map<string, TaskResult>();

      // Call unified reply generation method
      // This method handles all cases: with/without task results, with/without search
      await this.aiService.generateReplyFromTaskResults(hookContext, taskResults);

      // Get result from context.reply
      // Check both text reply and card image reply
      const replyContent = getReplyContent(hookContext);
      if (replyContent && replyContent.segments && replyContent.segments.length > 0) {
        // Extract text from segments (may be empty for card images)
        const replyText = getReply(hookContext) || '';

        // For card images, return a placeholder text indicating the reply was generated
        const hasCardImage = replyContent.segments.some(seg => seg.type === 'image' && replyContent.metadata?.isCardImage);
        const finalReply = hasCardImage && !replyText
          ? '[Card image reply generated]'
          : replyText || '[Reply generated]';

        return {
          success: true,
          reply: finalReply,
          metadata: {
            source: 'ai',
            hasCardImage,
          },
        };
      }

      return {
        success: false,
        reply: 'Reply generation failed',
        error: 'No reply generated',
      };
    } catch (error) {
      logger.error('[ReplyTaskExecutor] Error generating reply:', error);
      return {
        success: false,
        reply: 'Reply generation failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
