// Thread Context Compression Service (Phase 4) - async summarize oldest segment, replace in thread

import type { PromptManager } from '@/ai/PromptManager';
import type { LLMService } from '@/ai/services/LLMService';
import { logger } from '@/utils/logger';
import type { ThreadMessage, ThreadService } from './ThreadService';

/** When thread message count exceeds this, we may compress the earliest segment. */
const MAX_CONTEXT_MESSAGES = 30;
/** Number of earliest messages to summarize and replace with one summary message. */
const SEGMENT_SIZE = 10;

/**
 * Runs summarization and replacement in the background. Does not block the message pipeline.
 * Triggered after analysis; only one compression run per thread at a time.
 */
export class ThreadContextCompressionService {
  /** Thread IDs currently being compressed; avoid concurrent compress for same thread. */
  private compressingThreadIds = new Set<string>();

  constructor(
    private threadService: ThreadService,
    private llmService: LLMService,
    private promptManager: PromptManager,
  ) { }

  /**
   * Schedule compression check for all active threads in the group (async, non-blocking).
   * Call after analysis; does not block reply flow.
   */
  scheduleCompression(groupId: string): void {
    setImmediate(() => {
      void this.compressThreadsForGroup(groupId);
    });
  }

  /**
   * For each active thread in the group, compress earliest segment if over limit.
   */
  private async compressThreadsForGroup(groupId: string): Promise<void> {
    const threads = this.threadService.getActiveThreads(groupId);
    for (const thread of threads) {
      await this.compressThreadIfNeeded(thread.threadId);
    }
  }

  /**
   * If thread has more than MAX_CONTEXT_MESSAGES, summarize the earliest SEGMENT_SIZE and replace.
   * One compression per thread at a time; on failure leaves thread unchanged and logs.
   */
  private async compressThreadIfNeeded(threadId: string): Promise<void> {
    if (this.compressingThreadIds.has(threadId)) {
      return;
    }
    const thread = this.threadService.getThread(threadId);
    if (!thread || thread.messages.length <= MAX_CONTEXT_MESSAGES) {
      return;
    }

    this.compressingThreadIds.add(threadId);
    try {
      const segmentLength = Math.min(SEGMENT_SIZE, thread.messages.length - 1);
      if (segmentLength <= 0) {
        return;
      }
      const segment = thread.messages.slice(0, segmentLength);
      const conversationText = this.formatSegmentForSummarize(segment);
      const prompt = this.promptManager.render('llm.summarize', { conversationText });

      const response = await this.llmService.generate(prompt, {
        temperature: 0.5,
        maxTokens: 200,
      });

      const summaryText = (response.text || '').trim();
      if (!summaryText) {
        logger.warn(`[ThreadContextCompressionService] Empty summary for thread ${threadId}, skipping replace`);
        return;
      }

      this.threadService.replaceEarliestWithSummary(threadId, segmentLength, summaryText);
    } catch (error) {
      logger.error(`[ThreadContextCompressionService] Summarize failed for thread ${threadId}:`, error);
    } finally {
      this.compressingThreadIds.delete(threadId);
    }
  }

  private formatSegmentForSummarize(messages: ThreadMessage[]): string {
    return messages
      .map((m) => {
        const who = m.isBotReply ? 'Assistant' : `User<${m.userId}>`;
        return `${who}: ${m.content}`;
      })
      .join('\n');
  }
}
