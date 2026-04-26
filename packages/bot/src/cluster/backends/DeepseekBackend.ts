/**
 * DeepseekBackend — drives DeepSeek coding-agent workers.
 *
 * DeepSeek exposes an Anthropic-compatible endpoint at
 * `https://api.deepseek.com/anthropic`, so the same `claude` Code CLI binary
 * that drives our ClaudeCliBackend can talk to DeepSeek unchanged — we just
 * override `ANTHROPIC_BASE_URL`, point the model alias env vars at DeepSeek
 * model names, and supply the DeepSeek API key via `ANTHROPIC_AUTH_TOKEN`.
 *
 * Two important differences from MinimaxBackend:
 *
 *   1. Auth env var is `ANTHROPIC_AUTH_TOKEN`, NOT `ANTHROPIC_API_KEY`.
 *      DeepSeek's coding-agents guide explicitly uses AUTH_TOKEN; using
 *      API_KEY does not authenticate against their endpoint.
 *
 *   2. Claude Code internally selects different model tiers for different
 *      operations (main turn vs. summarization vs. subagent dispatch). On
 *      Anthropic those map to opus/sonnet/haiku; if we don't remap them to
 *      DeepSeek model names, the CLI will send `claude-*` strings to
 *      DeepSeek and the request will fail. So this backend bakes in
 *      ANTHROPIC_DEFAULT_OPUS_MODEL / SONNET_MODEL / HAIKU_MODEL and
 *      CLAUDE_CODE_SUBAGENT_MODEL alongside ANTHROPIC_MODEL.
 *
 * Like MinimaxBackend, this is a façade over ClaudeCliBackend so cluster
 * logs / WebUI / status panels show "this is a DeepSeek worker", not
 * "another claude worker", and so we have a single source of truth for
 * how to spawn the `claude` binary.
 *
 * Per-template overrides still win — user-supplied env merges on top of
 * the baked-in defaults, so a template can pin a different DeepSeek model
 * variant or tweak CLAUDE_CODE_EFFORT_LEVEL without touching this file.
 */

import type { ParsedWorkerOutput, WorkerBackend, WorkerSpawnConfig } from '../types';
import { ClaudeCliBackend } from './ClaudeCliBackend';

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';
const DEEPSEEK_FAST_MODEL = 'deepseek-v4-flash';

export class DeepseekBackend implements WorkerBackend {
  name = 'deepseek-cli';

  private readonly inner = new ClaudeCliBackend();

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // Bake in DeepSeek routing + model-alias remapping. Template-provided
    // env still wins so users can pin specific variants per template.
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: DEEPSEEK_DEFAULT_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_DEFAULT_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_DEFAULT_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_FAST_MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_FAST_MODEL,
      ...config.env,
    };

    return this.inner.spawn({ ...config, env });
  }

  /**
   * Delegate output parsing to the inner ClaudeCliBackend — DeepSeek goes
   * through claude CLI's Anthropic-compat client path, so the JSONL schema
   * for `--output-format stream-json` is identical.
   */
  parseOutput(raw: string): ParsedWorkerOutput {
    return this.inner.parseOutput(raw);
  }
}
