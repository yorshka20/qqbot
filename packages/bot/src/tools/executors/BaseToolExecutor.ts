// Base tool executor - abstract base class for tool executors

import type { ToolCall, ToolExecutionContext, ToolExecutor, ToolResult } from '../types';

export abstract class BaseToolExecutor implements ToolExecutor {
  abstract name: string;

  abstract execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> | ToolResult;

  protected success(reply: string, data?: Record<string, unknown>): ToolResult {
    return {
      success: true,
      reply,
      data,
    };
  }

  protected error(reply: string, error: string): ToolResult {
    return {
      success: false,
      reply,
      error,
    };
  }
}
