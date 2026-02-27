// RAG Query Extraction Service - extracts short keyword queries for vector search via LLM

import type { LLMService } from './LLMService';
import type { PromptManager } from '../prompt/PromptManager';
import { logger } from '@/utils/logger';

/** Max characters of input text to send to LLM to avoid token overflow. */
const MAX_INPUT_LENGTH = 500;

/**
 * Parse LLM response into an array of query strings.
 * Supports: RAG_QUERIES:\nline1\nline2  and  查询1: keyword1\n查询2: keyword2
 */
function parseRAGQueries(response: string): string[] {
  const trimmed = response.trim();
  if (!trimmed) {
    return [];
  }
  const upper = trimmed.toUpperCase();

  // Format: RAG_QUERIES:\nkeyword1\nkeyword2
  if (upper.startsWith('RAG_QUERIES:')) {
    const content = trimmed.substring(12).trim();
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // Format: 查询1: keyword1\n查询2: keyword2
  const queries: string[] = [];
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^查询\d+:\s*(.+)$/);
    if (match) {
      const q = match[1].trim();
      if (q) {
        queries.push(q);
      }
    }
  }
  if (queries.length > 0) {
    return queries;
  }

  // Fallback: treat each non-empty line as one query (e.g. raw list)
  const asLines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  return asLines.length > 0 ? asLines : [];
}

/** Optional context for RAG query extraction (history, memory) so the LLM can produce better queries. */
export interface RAGQueryExtractionContext {
  conversationContext?: string;
  memoryContext?: string;
}

/**
 * RAG Query Extraction Service
 * Uses an LLM to extract 1-5 short keyword queries from user message or topic for vector similarity search.
 */
export class RAGQueryExtractionService {
  constructor(
    private llmService: LLMService,
    private promptManager: PromptManager,
  ) {}

  /**
   * Extract short keyword queries from input text for RAG vector search.
   * Optional context (conversationContext, memoryContext) is passed into the prompt so the LLM can use history and memory.
   * On failure or empty result, returns [] (no search).
   */
  async extractQueries(
    inputText: string,
    sessionId?: string,
    context?: RAGQueryExtractionContext,
  ): Promise<string[]> {
    const trimmed = inputText.trim();
    if (!trimmed) {
      return [];
    }

    const truncated = trimmed.length > MAX_INPUT_LENGTH ? trimmed.slice(0, MAX_INPUT_LENGTH) : trimmed;
    const conversationContext = context?.conversationContext?.trim() || '(无)';
    const memoryContext = context?.memoryContext?.trim() || '(无)';

    try {
      const prompt = this.promptManager.render('rag.query_extraction', {
        inputText: truncated,
        conversationContext,
        memoryContext,
      });
      const response = await this.llmService.generate(prompt, {
        temperature: 0.3,
        maxTokens: 150,
        sessionId,
      });
      const text = (response?.text ?? '').trim();
      const queries = parseRAGQueries(text);
      if (queries.length > 0) {
        return queries;
      }
    } catch (err) {
      logger.warn('[RAGQueryExtractionService] LLM extraction failed, returning no queries:', err);
    }
    return [];
  }
}
