// AI Provider type definitions
// Middle layer and upstream use OpenAI Chat Completions format as the canonical message shape.
// Message and content types are aligned with OpenAI so they can be used directly with OpenAI/Doubao;
// other providers convert ChatMessage[] to their own API format internally.

import type OpenAI from 'openai';

/**
 * Base chat message roles (text dialogue; no tool).
 * Use for conversation history and provider API messages that do not include tool role.
 */
export type ChatMessageRoleBase = 'user' | 'assistant' | 'system';

/**
 * Full chat message role (includes tool for tool-use round-trips).
 */
export type ChatMessageRole = ChatMessageRoleBase | 'tool';

/**
 * Role for conversation history entries (user and assistant only; no system in history).
 */
export type ConversationHistoryRole = 'user' | 'assistant';

/**
 * Message in conversation history (plain text only; used by context/history loading).
 */
export interface ConversationMessage {
  role: ChatMessageRoleBase;
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
 * Tool call payload (for assistant messages with tool_calls).
 * Used when building messages for tool-use round-trips (OpenAI-compatible).
 */
export interface ChatMessageToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Chat message payload for role-based generation.
 * Structurally compatible with OpenAI ChatCompletionMessageParam for system / user / assistant.
 * When provider has vision, content can be ContentPart[] so history can include inline images (base64 data URL).
 * Non-OpenAI providers (e.g. Anthropic) convert ContentPart[] to their own format.
 * For tool-use: assistant may have tool_calls; role 'tool' carries tool_call_id and content.
 */
export interface ChatMessage {
  role: ChatMessageRole;
  /** Required for user/system; optional for assistant (e.g. when only tool_calls); for role 'tool' use string. */
  content?: ChatMessageContent;
  /** When role is 'tool', required for OpenAI: id of the tool call this result belongs to. */
  tool_call_id?: string;
  /** When role is 'assistant' and LLM returned tool_calls (e.g. OpenAI). */
  tool_calls?: ChatMessageToolCall[];
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
  /**
   * Optional tool definitions for function calling.
   * When provided and non-empty, provider may return functionCall in response.
   */
  tools?: ToolDefinition[];
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
  /** When request had tools and model chose to call a function (provider returned tool_calls). */
  functionCall?: FunctionCall;
  /** Provider's tool_call id (e.g. OpenAI); required to send tool result in next round. */
  toolCallId?: string;
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

/**
 * Tool/Function calling types (OpenAI-compatible)
 */

/** Tool definition for function calling */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
        default?: unknown;
        items?: { type: string };
      }
    >;
    required?: string[];
  };
}

/** Function call from LLM */
export interface FunctionCall {
  name: string;
  arguments: string; // JSON string
}

/** Tool call result */
export interface ToolResult {
  tool: string;
  result: unknown;
  error?: string;
}

/** Tool Use generation options */
export interface ToolUseGenerateOptions extends AIGenerateOptions {
  tools?: ToolDefinition[];
  maxToolRounds?: number; // Maximum rounds of tool calling (default: 3)
  toolExecutor?: (call: FunctionCall) => Promise<unknown>; // Function to execute tool calls
}

/** Tool Use generation response */
export interface ToolUseGenerateResponse extends AIGenerateResponse {
  functionCall?: FunctionCall; // If LLM wants to call a function
  toolCalls?: ToolResult[]; // All tool calls made during generation
  stopReason?: 'end_turn' | 'tool_use' | 'max_rounds'; // Why generation stopped
}
