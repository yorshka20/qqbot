// CodeSandbox - executes user code in a controlled environment

import { logger } from '@/utils/logger';
import type { SandboxConfig, SandboxExecutionResult, SandboxGlobals } from './types';
import { DEFAULT_SANDBOX_CONFIG } from './types';

/**
 * Executes JavaScript code in a controlled environment with:
 * - Injected globals (tools, console, standard utilities)
 * - Timeout protection
 * - Output capture
 * - Error handling
 *
 * Uses AsyncFunction constructor to create a function from code string,
 * with explicit parameter names to control scope.
 */
export class CodeSandbox {
  private config: SandboxConfig;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  /**
   * Execute code with the given globals injected as local variables.
   *
   * The code is wrapped in an AsyncFunction whose parameter names match
   * the keys of `globals`. This means the code can reference `tools`,
   * `console`, `fetch`, etc. directly.
   *
   * @param code - JavaScript code string to execute
   * @param globals - Sandbox globals to inject
   * @returns Execution result with return value, console output, and timing
   */
  async execute(code: string, globals: SandboxGlobals): Promise<SandboxExecutionResult> {
    const startTime = Date.now();

    try {
      // Build the async function with injected globals as parameters
      const fn = this.buildFunction(code, globals);

      // Execute with timeout
      const returnValue = await this.executeWithTimeout(fn, this.config.timeoutMs);

      const executionTimeMs = Date.now() - startTime;

      return {
        success: true,
        returnValue: this.serializeReturnValue(returnValue),
        consoleOutput: [], // caller fills this from SandboxContext
        executionTimeMs,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage = this.formatError(error);

      logger.debug(`[CodeSandbox] Execution failed (${executionTimeMs}ms): ${errorMessage}`);

      return {
        success: false,
        consoleOutput: [], // caller fills this from SandboxContext
        error: errorMessage,
        executionTimeMs,
      };
    }
  }

  /**
   * Build an async function from the code string.
   *
   * The function receives sandbox globals as named parameters, so user code
   * can reference them directly (e.g. `await tools.search({ query: "test" })`).
   */
  private buildFunction(code: string, globals: SandboxGlobals): () => Promise<unknown> {
    const paramNames = Object.keys(globals);
    const paramValues = Object.values(globals);

    const wrappedCode = this.addImplicitReturn(code);

    // Create AsyncFunction with globals as named parameters
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction(...paramNames, wrappedCode) as (...args: unknown[]) => Promise<unknown>;

    // Return a thunk that calls the function with the actual global values
    return () => fn(...paramValues);
  }

  /**
   * Try to add an implicit `return` before the last expression so the
   * code's final value is captured.
   *
   * Strategy: attempt to prepend `return` to the last non-empty line,
   * then compile-check the result with `new Function()`. If that produces
   * a syntax error (e.g. multi-line expression, block closer), fall back
   * to the original code unchanged. This avoids fragile regex heuristics.
   */
  private addImplicitReturn(code: string): string {
    const lines = code.trimEnd().split('\n');

    // Find the last non-empty line
    let lastIdx = lines.length - 1;
    while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx--;
    if (lastIdx < 0) return code;

    const lastLine = lines[lastIdx].trim();

    // Already has return — use as-is
    if (/^return\b/.test(lastLine)) return code;

    // Try adding return to the last line
    const modified = [...lines];
    const indent = modified[lastIdx].match(/^(\s*)/)?.[1] ?? '';
    modified[lastIdx] = `${indent}return ${lastLine}`;
    const candidate = modified.join('\n');

    // Compile-check with AsyncFunction (supports await) — if adding return
    // breaks syntax, fall back to original code unchanged.
    try {
      const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
      new AsyncFn(candidate);
      return candidate;
    } catch {
      return code;
    }
  }

  /**
   * Execute a function with a timeout.
   * Rejects if execution exceeds the configured timeout.
   */
  private async executeWithTimeout(fn: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Execution timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      fn()
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        });
    });
  }

  /**
   * Serialize a return value for safe transport in the result.
   * Handles circular references and oversized output.
   */
  private serializeReturnValue(value: unknown): unknown {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    try {
      const serialized = JSON.stringify(value, null, 2);
      if (serialized.length > this.config.maxOutputLength) {
        return `${serialized.slice(0, this.config.maxOutputLength)}... (truncated)`;
      }
      return JSON.parse(serialized);
    } catch {
      return String(value);
    }
  }

  /**
   * Format an error into a readable message.
   */
  private formatError(error: unknown): string {
    if (error instanceof Error) {
      // Include stack trace for debugging but truncate
      const stack = error.stack?.split('\n').slice(0, 5).join('\n') ?? '';
      return `${error.message}\n${stack}`.trim();
    }
    return String(error);
  }
}
