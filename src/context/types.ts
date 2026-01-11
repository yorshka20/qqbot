// Context type definitions

/**
 * Conversation context - single conversation context
 */
export interface ConversationContext {
  userMessage: string;
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }>;
  systemPrompt?: string;
  metadata: Map<string, unknown>;
}

/**
 * Session context - session-level context (user/group long-term memory)
 */
export interface SessionContext {
  sessionId: string; // User ID or Group ID
  sessionType: 'user' | 'group';
  context: Record<string, unknown>;
  metadata: Map<string, unknown>;
}

/**
 * Global context - global context (bot config, system prompt, etc.)
 */
export interface GlobalContext {
  botConfig: Record<string, unknown>;
  systemPrompt: string;
  metadata: Map<string, unknown>;
}

/**
 * Context builder options
 */
export interface ContextBuilderOptions {
  maxHistory?: number;
  includeSystemPrompt?: boolean;
  includeMetadata?: boolean;
}

/**
 * Build context options
 */
export interface BuildContextOptions extends ContextBuilderOptions {
  sessionId: string;
  sessionType: 'user' | 'group';
  userId: number;
  groupId?: number;
  systemPrompt?: string;
}
