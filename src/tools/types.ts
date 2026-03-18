// Tool type definitions

import type { HookContext } from '@/hooks/types';

/**
 * Scope that controls where a tool is visible.
 * - 'reply': available as LLM tool in the reply generation flow
 * - 'subagent': available as LLM tool in SubAgent sessions
 * - 'internal': never exposed to LLM — only callable programmatically
 */
export type ToolScope = 'reply' | 'subagent' | 'internal';

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
   * Where this tool is visible. Defaults to ['reply', 'subagent'] when omitted.
   * Set to ['internal'] for executors that should never be exposed to LLM.
   */
  visibility?: ToolScope[];

  /** Tool parameters definition */
  parameters?: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      required: boolean;
      description: string;
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
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  reply: string;
  data?: Record<string, unknown>;
  error?: string;
  metadata?: Record<string, unknown>;
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
  userId: number;
  groupId?: number;
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
