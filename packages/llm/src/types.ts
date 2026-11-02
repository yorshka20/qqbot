// AI Provider type definitions
// Middle layer and upstream use OpenAI Chat Completions format as the canonical message shape.
// Message and content types are aligned with OpenAI so they can be used directly with OpenAI/Doubao;
// other providers convert ChatMessage[] to their own API format internally.

import type OpenAI from 'openai';
import type { ReasoningEffort } from './config';

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
 * One Anthropic thinking block, carried verbatim for echo-back.
 * The Anthropic API requires the assistant turn that carries tool_use blocks to be
 * echoed back exactly as received — thinking blocks included, `signature` unmodified;
 * rebuilding the turn without them silently drops the model's reasoning state between
 * tool rounds (and rejects the request outright for `redacted_thinking`).
 */
export interface ThinkingBlockEcho {
  type: 'thinking' | 'redacted_thinking';
  /** Thinking text (`type: 'thinking'`); may be empty when the API omits display. */
  thinking?: string;
  /** Cryptographic signature over the thinking content; echoed back unmodified. */
  signature?: string;
  /** Encrypted payload (`type: 'redacted_thinking'`). */
  data?: string;
}

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
  /**
   * Anthropic thinking blocks from the response that produced this assistant turn.
   * AnthropicProvider replays them verbatim (before text/tool_use) when the turn is
   * echoed back in the tool loop; other providers ignore this field.
   */
  thinking_blocks?: ThinkingBlockEcho[];
  /**
   * Name of the provider that produced this assistant turn (set for assistant
   * turns carrying tool_calls). Providers use it to tell their own turns from
   * foreign ones after a mid-loop fallback: foreign tool_calls turns can fail
   * signature/echo-back validation (DeepSeek reasoning_content, Gemini
   * thought_signature) and must be folded or degraded, while same-provider
   * turns must be replayed verbatim so the model keeps its first-person view
   * of what it did.
   */
  provider?: string;
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
   * Supported by: OpenAI, OpenRouter, DeepSeek, Doubao, Groq, SiliconFlow, Ollama (format: "json"),
   * Gemini (responseMimeType; ignored on tool-enabled calls, which the API rejects).
   * Note: Many APIs only guarantee a single JSON object (not top-level array). For array output
   * (e.g. [{}]), ask in the prompt for {"result": [...]} and use the "result" key after parsing,
   * or use ensureJsonObject() to wrap array responses into { result: array }.
   */
  jsonMode?: boolean;
  /**
   * Session the call belongs to. LLMService routes by it (session provider override) and
   * tags traces with it; providers ignore it — a provider sends exactly `messages`, or
   * `systemPrompt` + `prompt`, and never adds conversation history of its own.
   */
  sessionId?: string;
  /**
   * Whether to include reasoning content in the response (for providers that support reasoning)
   * Default: false (only include the final answer, not the reasoning process)
   * Set to true if you need the reasoning content (e.g., for task analysis or debugging)
   */
  includeReasoning?: boolean;
  reasoningEffort?: ReasoningEffort;
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
    /** Prompt tokens served from the provider's prefix cache; absent when the provider does not report it. */
    cachedPromptTokens?: number;
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
   * The model that actually served this response. LLMService stamps this centrally
   * from the call's target (its model, else the provider's configured default) so
   * callers don't have to guess from static config. A provider only needs to set this
   * itself when the model it actually used differs from that — e.g. it picks a
   * per-capability model from its own config — in which case the provider's value wins.
   */
  resolvedModel?: string;
  /**
   * The model's reasoning/thinking for this response, normalized by each provider from its own
   * API shape (DeepSeek `reasoning_content`, Anthropic `thinking` blocks, Gemini thought parts,
   * OpenAI Responses reasoning summaries, …). Providers own this normalization — the pipeline
   * consumes only this field and must never parse provider-specific reasoning shapes.
   * Must be echoed back on the assistant message in subsequent tool-use rounds for DeepSeek, or the API
   * will reject the request with "reasoning_content must be passed back". Other providers ignore it.
   */
  reasoningContent?: string;
  /**
   * Anthropic thinking blocks of this response, verbatim (text + signature). Set only by
   * AnthropicProvider; LLMService stamps them onto the assistant tool_calls message so the
   * next round's request echoes them back — see {@link ThinkingBlockEcho}.
   */
  thinkingBlocks?: ThinkingBlockEcho[];
}

/**
 * Streaming response handler
 */
export type StreamingHandler = (chunk: string) => void;

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
  /** Mirrors `ToolSpec.roundExempt`; read by the tool loop, never sent to a provider. */
  roundExempt?: true;
  /** Mirrors `ToolSpec.deliversContent`; read by the tool loop, never sent to a provider. */
  deliversContent?: true;
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
