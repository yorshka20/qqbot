// Ollama Preliminary Analysis Service - decides whether to proactively join (no RAG)

import type { AIManager } from '@/ai/AIManager';
import type { LLMCapability } from '@/ai/capabilities/LLMCapability';
import { isLLMCapability } from '@/ai/capabilities/LLMCapability';
import type { PromptManager } from '@/ai/PromptManager';
import { logger } from '@/utils/logger';

export interface PreliminaryAnalysisResult {
  shouldJoin: boolean;
  reason?: string;
  topic?: string;
  /** Phase 3: which existing thread to reply in (if any) */
  replyInThreadId?: string;
  /** Phase 3: true to create a new thread and reply there */
  createNew?: boolean;
  /** Phase 3: thread id to mark as ended (no more replies) */
  threadShouldEndId?: string;
  /** When replying in a thread: ids of recent messages that are relevant and should be added to that thread's context */
  messageIds?: string[];
}

/** Input for multi-thread analysis: one entry per active thread */
export interface ThreadContextForAnalysis {
  threadId: string;
  preferenceKey: string;
  contextText: string;
}

const OLLAMA_PROVIDER_NAME = 'ollama';

/**
 * Ollama Preliminary Analysis Service
 * Uses local Ollama to analyze recent messages and decide whether the bot should join.
 * Does not use RAG / preference knowledge base.
 */
export class OllamaPreliminaryAnalysisService {
  constructor(
    private aiManager: AIManager,
    private promptManager: PromptManager,
  ) { }

  /**
   * Run preliminary analysis: should the bot proactively join?
   * @param preferenceText - Rendered preference (persona) text
   * @param recentMessagesText - Formatted recent messages (or thread context)
   * @returns Parsed result; shouldJoin is false if Ollama unavailable or parse fails
   */
  async analyze(preferenceText: string, recentMessagesText: string): Promise<PreliminaryAnalysisResult> {
    const provider = this.aiManager.getProvider(OLLAMA_PROVIDER_NAME);
    if (!provider || !isLLMCapability(provider)) {
      logger.debug('[OllamaPreliminaryAnalysisService] Ollama provider not available, skipping');
      return { shouldJoin: false };
    }

    const llm = provider as LLMCapability;
    if (!provider.isAvailable()) {
      logger.debug('[OllamaPreliminaryAnalysisService] Ollama not available');
      return { shouldJoin: false };
    }

    let prompt: string;
    try {
      prompt = this.promptManager.render('analysis.ollama', {
        preferenceText,
        recentMessagesText: recentMessagesText || '(no messages)',
      });
    } catch (err) {
      logger.warn('[OllamaPreliminaryAnalysisService] Failed to render prompt:', err);
      return { shouldJoin: false };
    }

    logger.debug(`[OllamaPreliminaryAnalysisService] Prompt: \n${prompt}`);

    try {
      const response = await llm.generate(prompt, {
        temperature: 0.3,
        maxTokens: 500,
      });
      const text = (response.text || '').trim();
      return this.parseJsonResult(text);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[OllamaPreliminaryAnalysisService] Ollama call failed:', err);
      return { shouldJoin: false };
    }
  }

  /**
   * Run preliminary analysis when the group has multiple active threads (Phase 3).
   * Ollama chooses to reply in an existing thread, create a new thread, and optionally end a thread.
   */
  async analyzeWithThreads(
    preferenceText: string,
    recentMessagesText: string,
    threads: ThreadContextForAnalysis[],
  ): Promise<PreliminaryAnalysisResult> {
    const provider = this.aiManager.getProvider(OLLAMA_PROVIDER_NAME);
    if (!provider || !isLLMCapability(provider)) {
      logger.debug('[OllamaPreliminaryAnalysisService] Ollama provider not available, skipping');
      return { shouldJoin: false };
    }

    const llm = provider as LLMCapability;
    if (!provider.isAvailable()) {
      logger.debug('[OllamaPreliminaryAnalysisService] Ollama not available');
      return { shouldJoin: false };
    }

    const threadsDescription = threads
      .map(
        (t) =>
          `--- Thread id: ${t.threadId} (preference: ${t.preferenceKey}) ---\n${t.contextText.slice(0, 2000)}${t.contextText.length > 2000 ? '...' : ''}`,
      )
      .join('\n\n');

    let prompt: string;
    try {
      prompt = this.promptManager.render('analysis.ollama_multi', {
        preferenceText,
        recentMessagesText: recentMessagesText || '(no messages)',
        threadsDescription: threadsDescription || '(no threads)',
      });
    } catch (err) {
      logger.warn('[OllamaPreliminaryAnalysisService] Failed to render multi-thread prompt:', err);
      return { shouldJoin: false };
    }

    logger.debug(`[OllamaPreliminaryAnalysisService] Multi-thread prompt length: ${prompt.length}`);

    try {
      const response = await llm.generate(prompt, {
        temperature: 0.3,
        maxTokens: 600,
      });
      const text = (response.text || '').trim();
      return this.parseJsonResult(text);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn('[OllamaPreliminaryAnalysisService] Ollama call failed:', err);
      return { shouldJoin: false };
    }
  }

  private parseJsonResult(text: string): PreliminaryAnalysisResult {
    const defaultResult: PreliminaryAnalysisResult = { shouldJoin: false };
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.debug('[OllamaPreliminaryAnalysisService] No JSON found in response');
      return defaultResult;
    }
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const shouldJoin = obj.shouldJoin === true;
      const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
      const topic = typeof obj.topic === 'string' ? obj.topic : undefined;
      const replyInThreadId =
        typeof obj.replyInThreadId === 'string' && obj.replyInThreadId.trim()
          ? obj.replyInThreadId.trim()
          : undefined;
      const createNew = obj.createNew === true;
      const threadShouldEndId =
        typeof obj.threadShouldEndId === 'string' && obj.threadShouldEndId.trim()
          ? obj.threadShouldEndId.trim()
          : undefined;
      let messageIds: string[] | undefined;
      if (Array.isArray(obj.messageIds)) {
        messageIds = obj.messageIds
          .map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? x : null))
          .filter((x): x is string => x != null && x.length > 0);
      }
      return {
        shouldJoin,
        reason,
        topic,
        replyInThreadId,
        createNew: createNew || undefined,
        threadShouldEndId,
        messageIds: messageIds?.length ? messageIds : undefined,
      };
    } catch {
      logger.debug('[OllamaPreliminaryAnalysisService] Failed to parse JSON');
      return defaultResult;
    }
  }
}
