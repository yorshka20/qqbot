// Types for execute_code tool

import type { ToolResult } from '../../types';

/**
 * Configuration for the code sandbox execution environment.
 */
export interface SandboxConfig {
  /** Maximum execution time in milliseconds (default: 10000) */
  timeoutMs: number;
  /** Maximum output length in characters (default: 8000) */
  maxOutputLength: number;
  /** Maximum number of console.log calls captured (default: 100) */
  maxConsoleLogs: number;
}

/**
 * A tool function exposed to the sandbox as a global.
 * Wraps a real tool executor into a simple async function.
 */
export interface SandboxToolFunction {
  /** Tool name */
  name: string;
  /** Description for the LLM to understand what this function does */
  description: string;
  /** The callable async function */
  fn: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * The execution context passed into the sandbox.
 * Contains all globals available to user code.
 */
export interface SandboxGlobals {
  /** Wrapped tool functions keyed by tool name */
  tools: Record<string, (params: Record<string, unknown>) => Promise<ToolResult>>;
  /** Console capture object */
  console: SandboxConsole;
  /** Standard JS utilities */
  fetch: typeof globalThis.fetch;
  URL: typeof globalThis.URL;
  URLSearchParams: typeof globalThis.URLSearchParams;
  JSON: typeof globalThis.JSON;
  Math: typeof globalThis.Math;
  Date: typeof globalThis.Date;
  Array: typeof globalThis.Array;
  Object: typeof globalThis.Object;
  Map: typeof globalThis.Map;
  Set: typeof globalThis.Set;
  RegExp: typeof globalThis.RegExp;
  Promise: typeof globalThis.Promise;
  parseInt: typeof globalThis.parseInt;
  parseFloat: typeof globalThis.parseFloat;
  isNaN: typeof globalThis.isNaN;
  isFinite: typeof globalThis.isFinite;
  encodeURIComponent: typeof globalThis.encodeURIComponent;
  decodeURIComponent: typeof globalThis.decodeURIComponent;
  atob: typeof globalThis.atob;
  btoa: typeof globalThis.btoa;
}

/**
 * Captured console interface for the sandbox.
 */
export interface SandboxConsole {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

/**
 * Result of sandbox code execution.
 */
export interface SandboxExecutionResult {
  /** Whether execution completed successfully */
  success: boolean;
  /** Return value of the code (serialized) */
  returnValue?: unknown;
  /** Captured console output lines */
  consoleOutput: string[];
  /** Error message if execution failed */
  error?: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  timeoutMs: 10_000,
  maxOutputLength: 8_000,
  maxConsoleLogs: 100,
};
