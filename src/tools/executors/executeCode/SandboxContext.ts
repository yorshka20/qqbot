// SandboxContext - builds the execution environment for user code

import { logger } from '@/utils/logger';
import type { ToolManager } from '../../ToolManager';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from '../../types';
import type { SandboxConfig, SandboxConsole, SandboxGlobals, SandboxToolFunction } from './types';

/**
 * Builds the sandboxed execution context with tool wrappers and captured console.
 *
 * Responsibilities:
 * - Wraps registered tool executors as simple async functions
 * - Creates a captured console that records output
 * - Provides safe standard JS globals
 */
export class SandboxContext {
  private consoleLogs: string[] = [];

  constructor(
    private toolManager: ToolManager,
    private executionContext: ToolExecutionContext,
    private config: SandboxConfig,
  ) {}

  /**
   * Build the full globals object for the sandbox.
   */
  buildGlobals(): SandboxGlobals {
    return {
      tools: this.buildToolFunctions(),
      console: this.buildConsole(),
      // Standard JS utilities (safe subset)
      fetch: globalThis.fetch.bind(globalThis),
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      JSON: globalThis.JSON,
      Math: globalThis.Math,
      Date: globalThis.Date,
      Array: globalThis.Array,
      Object: globalThis.Object,
      Map: globalThis.Map,
      Set: globalThis.Set,
      RegExp: globalThis.RegExp,
      Promise: globalThis.Promise,
      parseInt: globalThis.parseInt,
      parseFloat: globalThis.parseFloat,
      // biome-ignore lint/suspicious/noGlobalIsNan: sandbox provides standard JS globals for LLM code
      isNaN: globalThis.isNaN,
      // biome-ignore lint/suspicious/noGlobalIsFinite: sandbox provides standard JS globals for LLM code
      isFinite: globalThis.isFinite,
      encodeURIComponent: globalThis.encodeURIComponent,
      decodeURIComponent: globalThis.decodeURIComponent,
      atob: globalThis.atob,
      btoa: globalThis.btoa,
    };
  }

  /**
   * Get all captured console output.
   */
  getConsoleLogs(): string[] {
    return [...this.consoleLogs];
  }

  /**
   * Build tool wrapper functions from all registered non-internal tools.
   * Each tool becomes an async function: `tools.search({ query: "..." })`
   */
  private buildToolFunctions(): Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> {
    const toolFunctions: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>> = {};
    const availableTools = this.getAvailableToolFunctions();

    for (const tool of availableTools) {
      toolFunctions[tool.name] = tool.fn;
    }

    return toolFunctions;
  }

  /**
   * Discover and wrap all non-internal, non-execute_code tools.
   */
  private getAvailableToolFunctions(): SandboxToolFunction[] {
    const toolSpecs = this.toolManager.getAllTools();
    const functions: SandboxToolFunction[] = [];

    for (const spec of toolSpecs) {
      // Skip internal tools and self (prevent recursion)
      const visibility = spec.visibility ?? ['reply', 'subagent'];
      if (visibility.includes('internal') || spec.name === 'execute_code') {
        continue;
      }

      const executor = this.toolManager.getExecutor(spec.executor);
      if (!executor) {
        continue;
      }

      const wrappedFn = this.wrapToolExecutor(spec.name, spec.executor, executor);
      functions.push({
        name: spec.name,
        description: spec.description,
        fn: wrappedFn,
      });
    }

    return functions;
  }

  /**
   * Wrap a tool executor into a simple async function.
   */
  private wrapToolExecutor(
    toolName: string,
    executorName: string,
    executor: ToolExecutor,
  ): (params: Record<string, unknown>) => Promise<ToolResult> {
    const context = this.executionContext;

    return async (params: Record<string, unknown>): Promise<ToolResult> => {
      logger.debug(`[SandboxContext] Code calling tool: ${toolName}`, { params });

      const toolCall = {
        type: toolName,
        parameters: params ?? {},
        executor: executorName,
      };

      try {
        const result = (await executor.execute(toolCall, context)) as ToolResult;
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`[SandboxContext] Tool ${toolName} failed in sandbox:`, err);
        return {
          success: false,
          reply: `Tool ${toolName} failed: ${err.message}`,
          error: err.message,
        };
      }
    };
  }

  /**
   * Build a console object that captures output instead of printing to stdout.
   */
  private buildConsole(): SandboxConsole {
    const logs = this.consoleLogs;
    const maxLogs = this.config.maxConsoleLogs;

    const capture = (level: string) => {
      return (...args: unknown[]) => {
        if (logs.length >= maxLogs) {
          if (logs.length === maxLogs) {
            logs.push(`[${level}] ... (output truncated, max ${maxLogs} entries)`);
          }
          return;
        }
        const message = args
          .map((arg) => {
            if (typeof arg === 'string') return arg;
            try {
              return JSON.stringify(arg, null, 2);
            } catch {
              return String(arg);
            }
          })
          .join(' ');
        logs.push(`[${level}] ${message}`);
      };
    };

    return {
      log: capture('log'),
      warn: capture('warn'),
      error: capture('error'),
      info: capture('info'),
    };
  }
}
