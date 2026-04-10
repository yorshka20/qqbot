/**
 * MinimaxBackend — drives MiniMax M2 (CN) coding agent workers.
 *
 * MiniMax does NOT publish a hosted agent product; the only programmatic
 * entry point is their stateless chat-completions API. They DO expose an
 * Anthropic-compatible endpoint at `https://api.minimaxi.com/anthropic`,
 * which means the same `claude` Code CLI binary that drives our
 * ClaudeCliBackend can talk to MiniMax M2 unchanged — we just override
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` and supply a MiniMax API key
 * via `ANTHROPIC_API_KEY`.
 *
 * Rather than asking users to configure a `claude-cli` template with a
 * pile of env-var redirects (which obscures *which provider* a worker is
 * actually running), this backend is a thin façade that:
 *
 *   1. Composes ClaudeCliBackend internally (single source of truth for
 *      how to spawn the `claude` binary).
 *   2. Bakes in MiniMax CN base URL + default model so the template only
 *      needs to provide `ANTHROPIC_API_KEY`.
 *   3. Reports its own backend name `minimax-cli` so cluster logs / WebUI
 *      / status panels show "this is a MiniMax worker", not "another
 *      claude worker".
 *
 * Per-template overrides (e.g. a different `ANTHROPIC_MODEL` for M2.5)
 * still win — user-supplied env merges on top of the baked-in defaults.
 *
 * See cluster learnings doc for the architectural rationale.
 */

import type { ParsedWorkerOutput, WorkerBackend, WorkerSpawnConfig } from '../types';
import { ClaudeCliBackend } from './ClaudeCliBackend';

const MINIMAX_CN_ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic';
const MINIMAX_DEFAULT_MODEL = 'MiniMax-M2.7';

export class MinimaxBackend implements WorkerBackend {
  name = 'minimax-cli';

  private readonly inner = new ClaudeCliBackend();

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // Bake in MiniMax CN routing. Template-provided env still wins so users
    // can pin a specific model variant or swap to a different MiniMax key
    // per template without touching this file.
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: MINIMAX_CN_ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: MINIMAX_DEFAULT_MODEL,
      ...config.env,
    };

    return this.inner.spawn({ ...config, env });
  }

  /**
   * Delegate output parsing to the inner ClaudeCliBackend — MiniMax goes
   * through claude CLI's Anthropic-compat client path, so the JSONL schema
   * for `--output-format stream-json` is identical.
   */
  parseOutput(raw: string): ParsedWorkerOutput {
    return this.inner.parseOutput(raw);
  }
}
