// AI Provider type definitions
// Middle layer and upstream use OpenAI Chat Completions format as the canonical message shape.
// Message and content types are aligned with OpenAI so they can be used directly with OpenAI/Doubao;
// other providers convert ChatMessage[] to their own API format internally.

import type OpenAI from 'openai';

/**
 * Message in conversation history (plain text only; used by context/history loading).
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Re-use OpenAI Chat Completions content part types for full compatibility.
/** Text content part (OpenAI ChatCompletionContentPartText). */
export type ContentPartText = OpenAI.Chat.ChatCompletionContentPartText;
/** Image URL content part (OpenAI ChatCompletionContentPartImage). */
export type ContentPartImage = OpenAI.Chat.ChatCompletionContentPartImage;
/**
 * Content parts we use for multimodal messages (text + image).
 * Subset of OpenAI ChatCompletionContentPart (excludes input_audio, file, etc.).
 * @see https://platform.openai.com/docs/guides/vision
 * @see https://platform.openai.com/docs/api-reference/chat/create
 */
export type ContentPart = ContentPartText | ContentPartImage;

/**
 * Message content: string or array of content parts.
 * Same shape as OpenAI user message content (string | ChatCompletionContentPart[]).
 */
export type ChatMessageContent = string | ContentPart[];

/**
 * Chat message payload for role-based generation.
 * Structurally compatible with OpenAI ChatCompletionMessageParam for system / user / assistant.
 * When provider has vision, content can be ContentPart[] so history can include inline images (base64 data URL).
 * Non-OpenAI providers (e.g. Anthropic) convert ContentPart[] to their own format.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: ChatMessageContent;
}

/**
 * OpenAI Chat Completions message param type.
 * Use when calling OpenAI/Doubao client: messages as ChatCompletionMessageParam[].
 */
export type ChatCompletionMessageParam = OpenAI.Chat.ChatCompletionMessageParam;

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
  /**
   * Optional system message. When set, providers send it as high-priority system instructions.
   */
  systemPrompt?: string;
  /**
   * Optional role-based messages. When provided, providers must send these messages directly
   * and skip automatic history loading to avoid duplicate context injection.
   * Upstream and middle layer use OpenAI-standard ChatMessage[] (string | ContentPart[]); each provider converts to its own API format.
   */
  messages?: ChatMessage[];
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
