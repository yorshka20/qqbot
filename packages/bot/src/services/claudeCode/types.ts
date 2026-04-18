// Types for Claude Code tool executors

import type { ToolDefinition, ToolExecuteResult } from '../mcpServer/types';

/**
 * Interface for tool executors managed by ToolRegistry
 */
export interface ToolExecutor {
  name: string;
  definition: ToolDefinition;
  execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult>;
}

/**
 * Abstract base class for tool executors
 * Provides helper methods for creating success/error results
 */
export abstract class BaseToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract definition: ToolDefinition;

  abstract execute(parameters: Record<string, unknown>): Promise<ToolExecuteResult>;

  protected success(message: string, data?: unknown): ToolExecuteResult {
    return { success: true, message, data };
  }

  protected error(error: string, message?: string): ToolExecuteResult {
    return { success: false, error, message };
  }
}
