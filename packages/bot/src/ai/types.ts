// Types of the bot's LLM layer (LLMService, its tool loop and trace observers, prompt
// templates). The provider contract they build on is `@qqbot/llm`.

import type {
  AIGenerateOptions,
  AIGenerateResponse,
  ChatMessage,
  FunctionCall,
  FunctionCallInfo,
  ToolDefinition,
} from '@qqbot/llm';

export interface PromptTemplate {
  name: string;
  content: string;
  variables?: string[];
}

export interface SystemPrompt {
  content: string;
  variables?: Record<string, string>;
}

/** Tool call result */
export interface ToolResult {
  tool: string;
  result: unknown;
  error?: string;
}

/**
 * Options for a call through LLMService. The reasoning effort is required: left out, a call
 * runs at the vendor's default, which on thinking models is the most expensive setting
 * (DeepSeek: high), so every task states how much it should think. The model is not an
 * option: it travels with its provider in the call's `LLMTarget`, so a model can never
 * reach a provider it was not chosen for.
 */
export type LLMCallOptions = Omit<AIGenerateOptions, 'model'> & Required<Pick<AIGenerateOptions, 'reasoningEffort'>>;

/** Tool Use generation options */
export interface ToolUseGenerateOptions extends AIGenerateOptions {
  tools?: ToolDefinition[];
  maxToolRounds?: number; // Tool-round cap. Unset means no cap.
  toolExecutor?: (call: FunctionCall) => Promise<unknown>; // Function to execute tool calls
  // Invoked once per round with the provider/model that actually served it, before the
  // round's tool calls run — lets callers stamp the real model into context for tools
  // that render mid-loop (e.g. send_card footer).
  onProviderResolved?: (info: { providerName: string; model?: string }) => void;
  /**
   * Invoked with each round's thinking as soon as that round returns, before its
   * tool calls run — so a multi-round turn reports its reasoning incrementally
   * instead of as one blob at the end. Fires at most once per distinct block, and
   * is awaited so several rounds' output stays in order.
   *
   * `provider` is the one that actually served that round, passed explicitly because
   * a mid-turn fallback changes it and the caller cannot read it from context yet.
   */
  onReasoning?: (text: string, provider: string | undefined) => void | Promise<void>;
  /**
   * Invoked with the text a round wrote alongside its tool calls, before those calls
   * run, and awaited — a caller that delivers it lands it ahead of anything the tools
   * send and while a slow tool is still working. Only the final round's text (or the
   * text of a round that ends the turn via end_turn) is returned as `text`; this is
   * the only place every other round's text surfaces. `calls` lets the caller tell a
   * round that ends the turn, whose text also comes back as `text`. In a loop that
   * offers end_turn, a round that wrote text and called nothing is held: its text comes
   * with the next round's — here if that round calls tools, as `text` if it ends the turn.
   */
  onToolRoundText?: (text: string, calls: FunctionCall[]) => void | Promise<void>;
}

export type ToolUseCallOptions = Omit<ToolUseGenerateOptions, 'model'> &
  Required<Pick<AIGenerateOptions, 'reasoningEffort'>>;

/** Tool Use generation response */
export interface ToolUseGenerateResponse extends AIGenerateResponse {
  toolCalls?: ToolResult[]; // All tool calls made during generation
  /**
   * Why generation stopped:
   * - 'end_turn': a round with no tool calls, in a loop that does not offer `end_turn`
   * - 'end_turn_tool': model called the `end_turn` tool — the only normal exit of a loop
   *   that offers it
   * - 'tool_use': tool calls returned to the caller (no executor was supplied)
   * - 'max_rounds': round cap hit; a forced final text generation was appended, or the
   *   last round wrote text with no round left to ask whether the turn was done
   */
  stopReason?: 'end_turn' | 'end_turn_tool' | 'tool_use' | 'max_rounds';
  /**
   * Prompt tokens of the first round: the context the turn was asked with. `usage` sums
   * every round, and later rounds only add this turn's own tool traffic on top of it.
   */
  openingPromptTokens?: number;
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
  /**
   * Shared by every round of one generateWithTools loop, unique for any other call. A
   * later round's `messages` extend the earlier rounds' (their tool_calls and tool
   * results appended), so the latest entry of a conversation holds all of it.
   */
  conversationId: string;
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
    /**
     * Thinking text from reasoning models, recorded unconditionally so the effort
     * configuration is auditable from the dumps alone — token counts don't show
     * whether the model actually reasoned. Independent of the `/think` toggle,
     * which only controls whether it is also sent to the chat.
     */
    reasoningContent?: string;
  };
  /**
   * Wall time of the provider call, in ms. Spans `runWithProviderRetry`, so a
   * value inflated far past the model's own latency means retries happened.
   * Excludes the rate limiter's queue wait, which is not the request.
   */
  durationMs: number;
  sessionId?: string;
  /** Correlation key for the originating message turn (log tag, e.g. "msg:ab12cd"). */
  turnKey?: string;
}

/** Observer notified once per completed LLM call. Must not throw. */
export type LLMTraceObserver = (entry: LLMTraceEntry) => void;
