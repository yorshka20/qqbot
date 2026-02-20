// AI Provider type definitions

/**
 * Message in conversation history
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * AI generation options
 */
export interface AIGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  stream?: boolean;
  /**
   * Session ID for automatic context loading
   * If provided and provider has context enabled, will automatically load history from ContextManager
   */
  sessionId?: string;
  /**
   * Whether to include reasoning content in the response (for providers that support reasoning)
   * Default: false (only include the final answer, not the reasoning process)
   * Set to true if you need the reasoning content (e.g., for task analysis or debugging)
   */
  includeReasoning?: boolean;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * AI generation response
 */
export interface AIGenerateResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Streaming response handler
 */
export type StreamingHandler = (chunk: string) => void;

export interface PromptTemplate {
  name: string;
  content: string;
  variables?: string[];
}

export interface SystemPrompt {
  content: string;
  variables?: Record<string, string>;
}
