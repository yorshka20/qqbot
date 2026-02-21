// Thread Context Compression Service (Phase 4) - async summarize oldest segment, replace in thread; periodic topic cleaning

import type { PromptManager } from '@/ai/prompt/PromptManager';
import { logger } from '@/utils/logger';
import type { SummarizeService } from '../SummarizeService';
import type { ThreadMessage, ThreadService } from './ThreadService';

/** When thread message count exceeds this, we may compress the earliest segment. */
const MAX_CONTEXT_MESSAGES = 30;
/** Number of earliest messages to summarize and replace with one summary message. */
const SEGMENT_SIZE = 10;
/** Min messages before we run LLM topic cleaning (remove off-topic content). */
const MIN_MESSAGES_FOR_TOPIC_CLEAN = 8;

/**
 * Runs summarization and replacement in the background. Does not block the message pipeline.
 * Triggered after analysis; only one compression run per thread at a time.
 * Can optionally run LLM-based topic cleaning to remove off-topic messages from thread context.
 */
export class ThreadContextCompressionService {
  private compressingThreadIds = new Set<string>();
  private summarizeProvider = 'doubao';

  constructor(
    private threadService: ThreadService,
    private summarizeService: SummarizeService,
    private promptManager?: PromptManager,
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
   * For each active thread in the group: optionally clean off-topic messages, then compress earliest segment if over limit.
   */
  private async compressThreadsForGroup(groupId: string): Promise<void> {
    const threads = this.threadService.getActiveThreads(groupId);
    for (const thread of threads) {
      await this.cleanThreadTopicIfNeeded(thread.threadId, thread.preferenceKey);
      await this.compressThreadIfNeeded(thread.threadId);
    }
  }

  /**
   * If thread has enough messages and we have PromptManager, call LLM to keep only on-topic messages.
   */
  private async cleanThreadTopicIfNeeded(threadId: string, preferenceKey: string): Promise<void> {
    if (this.compressingThreadIds.has(threadId)) {
      return;
    }
    const thread = this.threadService.getThread(threadId);
    if (!thread || thread.messages.length < MIN_MESSAGES_FOR_TOPIC_CLEAN || !this.promptManager) {
      return;
    }

    const preferenceSummary = this.promptManager.render(`${preferenceKey}.summary`, {});
    this.compressingThreadIds.add(threadId);
    try {
      const contextWithIndices = this.threadService.getContextFormattedWithIndices(threadId);
      const keepIndices = await this.summarizeService.cleanThreadTopic(contextWithIndices, preferenceSummary, {
        provider: 'ollama',
      });
      if (keepIndices.length > 0 && keepIndices.length < thread.messages.length) {
        this.threadService.keepOnlyMessageIndices(threadId, keepIndices);
      }
    } catch (error) {
      logger.error(`[ThreadContextCompressionService] Topic clean failed for thread ${threadId}:`, error);
    } finally {
      this.compressingThreadIds.delete(threadId);
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

      const summaryText = await this.summarizeService.summarize(conversationText, {
        provider: this.summarizeProvider,
      });

      if (!summaryText) {
        logger.warn(
          `[ThreadContextCompressionService] Empty summary for thread ${threadId}, skipping replace | ` +
          `segmentLength=${segmentLength} conversationTextLength=${conversationText.length}`,
        );
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
