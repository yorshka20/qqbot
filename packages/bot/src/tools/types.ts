// Tool type definitions

import type { ContentPart } from '@/ai/types';
import type { MessageSource } from '@/conversation/sources';
import type { HookContext } from '@/hooks/types';

/**
 * Scope that controls where a tool is visible.
 * - 'reply': available as LLM tool in the reply generation flow
 * - 'subagent': available as LLM tool in SubAgent sessions
 * - 'internal': never exposed to LLM — only callable programmatically
 * - 'reflection': reserved for future use
 */
export type ToolScope = 'reply' | 'subagent' | 'internal' | 'reflection';

/**
 * Fine-grained reply-scope visibility config.
 */
export interface ReplyVisibility {
  /**
   * Real-IM sources where this tool should appear in the reply prompt.
   * Default (when omitted): all real-IM sources ['qq-private', 'qq-group', 'discord'].
   * Synthetic sources are EXCLUDED by default — list them explicitly to opt in.
   */
  sources?: readonly MessageSource[];
  /** Hide the tool unless the active user is an admin. Default: false. */
  adminOnly?: boolean;
}

/**
 * Rich visibility descriptor for a tool.
 * Replaces the legacy ToolScope[] form.
 */
export interface ToolVisibility {
  reply?: ReplyVisibility | true; // true = legacy: all real-IM sources, no admin gate
  subagent?: boolean;
  internal?: boolean;
  reflection?: boolean; // reserved; not consumed yet
}

/**
 * Normalize legacy ToolScope[] or ToolVisibility into canonical ToolVisibility form.
 * Idempotent: passing a ToolVisibility returns it unchanged.
 */
export function normalizeVisibility(input: ToolScope[] | ToolVisibility | undefined): ToolVisibility {
  if (!input) return {};
  if (Array.isArray(input)) {
    const v: ToolVisibility = {};
    for (const s of input) {
      if (s === 'reply') v.reply = true;
      else if (s === 'subagent') v.subagent = true;
      else if (s === 'internal') v.internal = true;
      else if (s === 'reflection') v.reflection = true;
    }
    return v;
  }
  return input;
}

/**
 * Tool specification — the rich internal definition of a tool.
 * Distinct from ToolDefinition (src/ai/types.ts) which is the slim
 * OpenAI-compatible schema sent to the LLM.
 */
export interface ToolSpec {
  /** Tool name (unique identifier) */
  name: string;

  /** Human-readable description of what this tool does */
  description: string;

  /** Executor identifier */
  executor: string;

  /**
   * Where this tool is visible. Normalized to ToolVisibility at decoration time.
   * Tools without visibility are not available in any scope.
   */
  visibility: ToolVisibility;

  /** Tool parameters definition */
  parameters?: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      required: boolean;
      description: string;
      /**
       * JSON Schema for array elements; required by OpenAI when type === 'array'.
       * Element objects may declare their own `properties` (with per-field `enum`)
       * so the model's constrained decoder enforces a discriminator instead of
       * free-generating it — the contract must live in the schema, not only prose.
       */
      items?: {
        type: string;
        enum?: string[];
        properties?: Record<string, { type: string; description?: string; enum?: string[] }>;
      };
      enum?: string[];
    };
  };

  /** Example user messages that would trigger this tool */
  examples?: string[];

  /** Keywords that help AI identify when to use this tool */
  triggerKeywords?: string[];

  /** Detailed guidance for AI on when to use this tool */
  whenToUse?: string;
}

/**
 * Tool call instance — a concrete invocation of a tool with parameters
 */
export interface ToolCall {
  id?: string;
  type: string; // Tool name
  parameters: Record<string, unknown>;
  reply?: string;
  executor: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Tool execution result.
 *
 * Contract: `reply` is the authoritative LLM-facing message. The LLM-facing
 * formatters (replyTools / agent ToolRunner / ReflectionEngine) render `reply`
 * to the model as the tool result content. `data` is reserved for specialized
 * non-LLM consumers (SandboxContext for execute_code, ContextResolutionStage
 * for fetch_image base64) and **must not** be used to smuggle the primary
 * content past `reply` — if the model needs to see it, put it in `reply`.
 */
export interface ToolResult {
  success: boolean;
  /** Authoritative human/LLM-readable message. Must contain everything the model needs. */
  reply: string;
  /**
   * Structured payload for specialized consumers (e.g. JS sandbox in execute_code,
   * image extraction in ContextResolutionStage). Not rendered to the LLM as content;
   * use only for fields that other code reads programmatically.
   */
  data?: Record<string, unknown>;
  error?: string;
  /** Internal telemetry; never reaches the LLM or downstream tool consumers. */
  metadata?: Record<string, unknown>;
  /**
   * Optional multimodal content parts (e.g. images) to inject into the conversation
   * after tool result messages. Used by tools like fetch_image that return vision content.
   * These are injected as a user message with ContentPart[] so all providers can see them.
   */
  contentParts?: ContentPart[];
}

/**
 * Tool executor interface
 */
export interface ToolExecutor {
  /** Executor identifier */
  name: string;

  /** Execute the tool call and return a result */
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> | ToolResult;
}

/**
 * Tool execution context
 */
export interface ToolExecutionContext {
  userId: number | string;
  groupId?: number | string;
  messageType: 'private' | 'group';
  conversationId?: string;
  messageId?: string;
  /** Hook context for executors to access full pipeline context */
  hookContext?: HookContext;
  /** Results from other tools (for reply tool to access) */
  toolResults?: Map<string, ToolResult>;
  /** Additional metadata for extensibility */
  metadata?: Record<string, unknown>;
}

/**
 * Tool analysis result
 */
export interface ToolAnalysisResult {
  tools: ToolCall[];
  suggestedProvider?: string;
  confidence?: number;
  reasoning?: string;
}
