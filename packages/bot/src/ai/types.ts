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
  /** Gemini thinking-model thought signature; must be echoed back in multi-turn tool use. */
  thought_signature?: string;
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
  /**
   * When role is 'assistant' and the provider uses a thinking/reasoning model (e.g. DeepSeek-Reasoner,
   * deepseek-v4 thinking, Doubao, Minimax), the model's returned `reasoning_content` MUST be echoed
   * back on the assistant message in the next API call for that provider. Otherwise DeepSeek returns
   * "The `reasoning_content` in the thinking mode must be passed back to the API." Other providers
   * ignore this field.
   */
  reasoning_content?: string;
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
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  stream?: boolean;
  /**
   * When true, request the provider to return valid JSON (e.g. response_format.json_object).
   * Supported by: OpenAI, OpenRouter, DeepSeek, Doubao, Ollama (format: "json").
   * Note: Many APIs only guarantee a single JSON object (not top-level array). For array output
   * (e.g. [{}]), ask in the prompt for {"result": [...]} and use the "result" key after parsing,
   * or use ensureJsonObject() to wrap array responses into { result: array }.
   */
  jsonMode?: boolean;
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
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
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
  /**
   * Enable provider-native web search / grounding when supported by the selected provider.
   * This is separate from app-defined tools such as local file, memory, or RAG access.
   */
  nativeWebSearch?: boolean;
  /**
   * Conversation episode identifier for prompt caching.
   * Used by providers (e.g. Anthropic) to anchor cache breakpoints at a stable position
   * across turns within the same episode, so history prefix hits cache reads instead of writes.
   * Changes when the episode rolls (e.g. after summary), resetting the cache anchor.
   */
  episodeKey?: string;
  /**
   * Per-call HTTP timeout in milliseconds. Overrides the provider's `defaultTimeout`
   * (configured at provider construction). Use for long-running structured tasks
   * (e.g. group_report large JSON generation) where the default 60-120s ceiling is
   * not enough. Honored by DeepSeek, Doubao (via shared HttpClient) and Gemini
   * (via SDK httpOptions.timeout). LLMService also enforces an outer hard timeout
   * around every provider.generate call as a safety net.
   */
  timeout?: number;
  /**
   * Controls verbosity of the `[LLMService] prompt [...]` log dump.
   * Default `true` keeps the legacy behavior (full prompt + every message body
   * is info-logged for debugging).
   *
   * Set `false` for callers whose prompt is a fixed boilerplate template with a
   * single variable slot (e.g. card-format conversion, where the {{cardTypeSpec}}
   * + {{cardDeckNote}} sections are constant noise and only the user-content slot
   * is informative). LLMService still logs the meta line
   * `[LLMService] prompt | provider=... | messages=N` so call counts stay traceable;
   * the caller is expected to log its own context line with the meaningful slot value.
   */
  verbosePromptLog?: boolean;
  /**
   * Request the provider's paid tier directly, skipping the free tier. For Gemini
   * this uses the paid key + `llm.paidModel` from the start instead of trying the
   * (possibly quota-exhausted) free key first. Used for explicit provider wake-words
   * where the user opted into the premium model. Single-tier providers ignore it.
   */
  preferPaidTier?: boolean;
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
  /**
   * All function calls returned by the model in this response.
   * Providers that support parallel tool calls (OpenAI, Gemini, Anthropic, etc.)
   * populate this array with every tool call from a single response.
   */
  functionCalls?: FunctionCallInfo[];
  /**
   * The provider name that actually generated this response.
   * Set by LLMService when internal fallback occurs, so callers know
   * which provider was used even after transparent fallback.
   */
  resolvedProviderName?: string;
  /**
   * The model that actually served this response. May differ from the provider's
   * configured default — e.g. Gemini swaps to `llm.paidModel` when the free key is
   * quota-exhausted, or to a caller-pinned model. Carried so downstream consumers
   * (card footer, usage stats, logs) report the real model instead of guessing
   * from static config.
   */
  resolvedModel?: string;
  /**
   * Raw reasoning_content returned by thinking/reasoning models (DeepSeek v4 thinking, Doubao, Minimax, etc.).
   * Must be echoed back on the assistant message in subsequent tool-use rounds for DeepSeek, or the API
   * will reject the request with "reasoning_content must be passed back". Other providers ignore it.
   */
  reasoningContent?: string;
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
/**
 * Minimal recursive JSON Schema node. Used to describe tool parameter shapes
 * (including array `items` and discriminated `anyOf` unions) so the model's
 * constrained decoder enforces the real contract instead of free-generating it.
 */
export interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
}

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
        items?: JsonSchemaNode;
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

/** Function call with provider metadata (tool call id, thought signature, etc.) */
export interface FunctionCallInfo extends FunctionCall {
  /** Provider's tool_call id (e.g. OpenAI tc.id); required to send tool result in next round. */
  toolCallId?: string;
  /** Gemini thinking-model thought signature; must be echoed back in multi-turn tool use. */
  thoughtSignature?: string;
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
  // Invoked once per round with the provider/model that actually served it, before the
  // round's tool calls run — lets callers stamp the real model into context for tools
  // that render mid-loop (e.g. send_card footer).
  onProviderResolved?: (info: { providerName: string; model?: string }) => void;
}

/** Tool Use generation response */
export interface ToolUseGenerateResponse extends AIGenerateResponse {
  toolCalls?: ToolResult[]; // All tool calls made during generation
  stopReason?: 'end_turn' | 'tool_use' | 'max_rounds'; // Why generation stopped
}

/**
 * One completed LLM call, surfaced to trace observers (e.g. dump-to-markdown).
 * Emitted from LLMService after every generation path (generate / generateLite /
 * generateFixed / generateStream); tool-use rounds appear as separate entries
 * (generateWithTools drives them through generate()), so a round's `messages`
 * already carry prior tool_calls + tool results. Observers must not throw —
 * LLMService invokes them in a try/catch so tracing never breaks generation.
 */
export interface LLMTraceEntry {
  /** Which generation entrypoint produced this call. */
  opLabel: string;
  provider: string;
  resolvedModel?: string;
  systemPrompt?: string;
  /** The flat prompt argument (used by legacy single-turn callers). */
  prompt: string;
  /** Role-based messages when the caller supplied them (the usual path). */
  messages?: ChatMessage[];
  /** Tool definitions exposed to the model for this call. */
  tools?: ToolDefinition[];
  response: {
    text: string;
    functionCalls?: FunctionCallInfo[];
    usage?: AIGenerateResponse['usage'];
  };
  sessionId?: string;
  /** Correlation key for the originating message turn (log tag, e.g. "msg:ab12cd"). */
  turnKey?: string;
}

/** Observer notified once per completed LLM call. Must not throw. */
export type LLMTraceObserver = (entry: LLMTraceEntry) => void;
