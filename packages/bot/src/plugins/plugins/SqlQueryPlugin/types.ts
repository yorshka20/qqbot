// Shared types for the read-only SQL query plugin

export interface SqlQueryPluginConfig {
  /** Wall-clock budget for a single query before the child process is killed (default: 15000) */
  timeoutMs?: number;
  /** Hard ceiling on rows a single query may return, regardless of the tool's `limit` (default: 200) */
  maxRows?: number;
  /** Character budget for the rendered result table handed back to the LLM (default: 6000) */
  maxOutputChars?: number;
}

export interface SqlQuerySuccess {
  ok: true;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** True when the row cap stopped iteration before the result set was exhausted. */
  truncated: boolean;
  elapsedMs: number;
}

export interface SqlQueryFailure {
  ok: false;
  error: string;
}

export type SqlQueryOutcome = SqlQuerySuccess | SqlQueryFailure;
