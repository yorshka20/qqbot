// Ollama Preliminary Analysis Service - decides whether to proactively join (no RAG)

import type { AIManager } from '@/ai/AIManager';
import type { LLMCapability } from '@/ai/capabilities/LLMCapability';
import { isLLMCapability } from '@/ai/capabilities/LLMCapability';
import type { PromptManager } from '@/ai/prompt/PromptManager';
import { type PreliminaryAnalysisResult, PreliminaryAnalysisSchema } from '@/ai/schemas';
import { type ExtractStrategy, parseLlmJson } from '@/ai/utils/llmJsonExtract';
import { logger } from '@/utils/logger';

/** analysis.ollama / analysis.ollama_multi expect JSON object; code block or raw. */
const PRELIMINARY_ANALYSIS_STRATEGIES: ExtractStrategy[] = ['codeBlock', 'braceMatch', 'regex'];

export type { PreliminaryAnalysisResult } from '@/ai/schemas';

/** Default result when LLM is unavailable or parse fails. */
const DEFAULT_ANALYSIS_RESULT: PreliminaryAnalysisResult = {
  shouldJoin: false,
  reason: undefined,
  topic: undefined,
  replyInThreadId: undefined,
  createNew: undefined,
  threadShouldEndId: undefined,
  messageIds: undefined,
  preferenceKey: undefined,
  searchQueries: undefined,
};

/** Input for multi-thread analysis: one entry per active thread */
export interface ThreadContextForAnalysis {
  threadId: string;
  preferenceKey: string;
  contextText: string;
  /** User ID (string) who triggered/started this thread; */
  triggerUserId?: string;
}

const DEFAULT_ANALYSIS_PROVIDER = 'ollama';

export interface PreliminaryAnalysisOptions {
  /** LLM provider name (e.g. "ollama", "doubao"). Default "ollama". */
  providerName?: string;
  /** When true, analysis is idle-triggered (no keyword); inject stricter instruction so AI avoids replying when topic has shifted and no one is interested. */
  idleMode?: boolean;
}

/**
 * Preliminary Analysis Service
 * Uses an LLM (Ollama, Doubao, etc.) to analyze recent messages and decide whether the bot should join.
 * Does not use RAG / preference knowledge base. Provider is configurable via plugin config (analysisProvider).
 */
export class PreliminaryAnalysisService {
  constructor(
    private aiManager: AIManager,
    private promptManager: PromptManager,
  ) {}

  /**
   * Run preliminary analysis: should the bot proactively join?
   * @param preferenceText - Rendered preference (persona) text
   * @param recentMessagesText - Formatted recent messages (or thread context)
   * @param options - Optional provider name (default "ollama")
   * @returns Parsed result; shouldJoin is false if provider unavailable or parse fails
   */
  async analyze(
    preferenceText: string,
    recentMessagesText: string,
    options?: PreliminaryAnalysisOptions,
  ): Promise<PreliminaryAnalysisResult> {
    const providerName = options?.providerName ?? DEFAULT_ANALYSIS_PROVIDER;
    const provider = this.aiManager.getProvider(providerName);
    if (!provider || !isLLMCapability(provider)) {
      return DEFAULT_ANALYSIS_RESULT;
    }

    const llm = provider as LLMCapability;
    if (!provider.isAvailable()) {
      return DEFAULT_ANALYSIS_RESULT;
    }

    const idleModeInstruction = this.resolveIdleModeInstruction(options?.idleMode);
    const baseSystemPrompt = this.promptManager.renderBasePrompt();
    const prompt = this.promptManager.render('analysis.ollama', {
      preferenceText,
      recentMessagesText,
      idleModeInstruction,
    });

    // logger.debug(`[PreliminaryAnalysisService] Prompt: \n${prompt}`);

    // prefer use generateLite if available, otherwise use generate
    const generate = llm.generateLite ?? llm.generate;
    try {
      const response = await generate.call(llm, prompt, {
        temperature: 0.2,
        maxTokens: 400,
        jsonMode: true,
        systemPrompt: baseSystemPrompt,
      });
      const text = response.text;
      return this.parseJsonResult(text);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(`[PreliminaryAnalysisService] Provider "${providerName}" call failed:`, err);
      return DEFAULT_ANALYSIS_RESULT;
    }
  }

  private buildThreadsDescription(threads: ThreadContextForAnalysis[]): string {
    return threads
      .map((t) => {
        const ownerHint = t.triggerUserId ? ` | 发起用户: ${t.triggerUserId}` : '';
        return `--- Thread id: ${t.threadId} (preference: ${t.preferenceKey}${ownerHint}) ---\n${t.contextText.slice(0, 400)}${t.contextText.length > 400 ? '...' : ''}`;
      })
      .join('\n\n');
  }

  /**
   * Run preliminary analysis when the group has multiple active threads (Phase 3).
   * LLM chooses to reply in an existing thread, create a new thread, and optionally end a thread.
   */
  async analyzeWithThreads(
    preferenceText: string,
    recentMessagesText: string,
    threads: ThreadContextForAnalysis[],
    options?: PreliminaryAnalysisOptions,
  ): Promise<PreliminaryAnalysisResult> {
    const providerName = options?.providerName ?? DEFAULT_ANALYSIS_PROVIDER;
    const provider = this.aiManager.getProvider(providerName);
    if (!provider || !isLLMCapability(provider)) {
      return DEFAULT_ANALYSIS_RESULT;
    }

    const llm = provider as LLMCapability;
    if (!provider.isAvailable()) {
      return DEFAULT_ANALYSIS_RESULT;
    }

    const threadsDescription = this.buildThreadsDescription(threads);
    const idleModeInstruction = this.resolveIdleModeInstruction(options?.idleMode);
    const baseSystemPrompt = this.promptManager.renderBasePrompt();
    const prompt = this.promptManager.render('analysis.ollama_multi', {
      preferenceText,
      recentMessagesText,
      threadsDescription,
      idleModeInstruction,
    });

    // prefer use generateLite if available, otherwise use generate
    const generate = llm.generateLite ?? llm.generate;
    try {
      const response = await generate.call(llm, prompt, {
        temperature: 0.2,
        maxTokens: 400,
        jsonMode: true,
        systemPrompt: baseSystemPrompt,
      });
      const text = response.text;
      return this.parseJsonResult(text);
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      logger.warn(`[PreliminaryAnalysisService] Provider "${providerName}" call failed:`, err);
      return DEFAULT_ANALYSIS_RESULT;
    }
  }

  /**
   * When idleMode is true, render the idle instruction fragment so the AI is more conservative
   * (do not join if topic has shifted and no one is interested).
   */
  private resolveIdleModeInstruction(idleMode?: boolean): string {
    if (!idleMode) {
      return '';
    }
    return this.promptManager.render('analysis.idle_instruction');
  }

  private parseJsonResult(text: string): PreliminaryAnalysisResult {
    const result = parseLlmJson(text, PreliminaryAnalysisSchema, {
      strategies: PRELIMINARY_ANALYSIS_STRATEGIES,
    });
    if (result == null) {
      logger.debug('[PreliminaryAnalysisService] No JSON found or failed to parse');
      return DEFAULT_ANALYSIS_RESULT;
    }
    return result;
  }
}
