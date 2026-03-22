// SubAgent system type definitions

/**
 * SubAgent types
 */
export enum SubAgentType {
  // Research types
  RESEARCH = 'research', // Information search and organization
  ANALYSIS = 'analysis', // Data analysis

  // Creative types
  WRITING = 'writing', // Text creation
  CODING = 'coding', // Code generation

  // Execution types
  TASK_EXECUTION = 'task', // Task execution
  VALIDATION = 'validation', // Validation and testing

  // General
  GENERIC = 'generic', // Generic sub-agent
}

/**
 * SubAgent configuration
 */
export interface SubAgentConfig {
  maxDepth: number; // Max sub-agent depth (default: 2)
  maxChildren: number; // Max children per agent (default: 5)
  timeout: number; // Timeout in ms (default: 300000 = 5 min)

  // Context inheritance control
  inheritSoul: boolean; // Inherit SOUL (default: false)
  inheritMemory: boolean; // Inherit memory (default: false)
  inheritPreference: boolean; // Inherit preference (default: false)

  // Tool permissions
  allowedTools: string[]; // Allowed tools (empty = allow all)
  restrictedTools: string[]; // Restricted tools (empty = no restrictions)
}

/**
 * SubAgent session
 */
export interface SubAgentSession {
  id: string; // Unique identifier
  parentId?: string; // Parent agent ID
  depth: number; // Depth level (0 = main agent)
  type: SubAgentType; // Agent type
  status: 'pending' | 'running' | 'completed' | 'failed';

  // Context isolation
  context: {
    groupId?: number | string;
    userId?: number | string;
    sessionId: string; // Independent session
    episodeId?: string; // Independent episode
    /** From parent when spawned from main flow; used by ToolRunner for ToolExecutionContext. */
    messageType?: 'private' | 'group';
    protocol?: string;
    conversationId?: string;
    messageId?: string;
  };

  // Task definition
  task: {
    description: string; // Task description
    input: unknown; // Input data
    output?: unknown; // Output result
  };

  // Lifecycle
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: Error;

  // Configuration
  config: SubAgentConfig;
}

/**
 * SubAgent context
 */
export interface SubAgentContext {
  sessionId: string;
  episodeId?: string;
  history: Array<{ role: string; content: string }>;
  memory: string;
  preference: string;
}

/**
 * Aggregated result
 */
export interface AggregatedResult {
  totalCount: number;
  completed: number;
  failed: number;
  results: Array<{
    type: SubAgentType;
    description: string;
    output: unknown;
  }>;
  errors: Array<{
    type: SubAgentType;
    description: string;
    error: string;
  }>;
}
