/**
 * ClaudeCliBackend — spawns Claude Code CLI as worker processes.
 *
 * Stateless: command/args come from WorkerSpawnConfig (which the WorkerPool
 * fills from the template). One backend instance is shared across all
 * `claude-cli` templates; per-template differences (model, args, env) flow
 * through the spawn config.
 *
 * Also used as the implementation for "anthropic-compat" providers
 * (e.g. MiniMax via ANTHROPIC_BASE_URL) — the same `claude` binary works
 * against any Anthropic-compatible endpoint when env vars are overridden.
 */

import { spawn } from 'bun';
import { parseClaudeStreamJson } from '@/utils/claudeStreamJson';
import { logger } from '@/utils/logger';
import type {
  CredentialProbeConfig,
  CredentialProbeResult,
  ParsedWorkerOutput,
  WorkerBackend,
  WorkerSpawnConfig,
} from '../types';
import { checkAnthropicCredential, interpretClaudeAuthStatus, runCliAuthStatus } from './providerCredentialCheck';

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

export class ClaudeCliBackend implements WorkerBackend {
  name = 'claude-cli';

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // Inject the cluster ContextHub MCP config so the worker's claude CLI
    // can call hub_sync / hub_claim / hub_report / hub_ask / etc. The
    // generated tmp file lives at config.mcpConfigPath and contains the
    // MCP server URL + X-Worker-Id header (see WorkerPool.generateMCPConfig).
    //
    // **Use the `--mcp-config=<path>` (single arg with `=`) form, NOT
    // `--mcp-config <path>` (two args).** Claude CLI parses `--mcp-config`
    // as a multi-value option that greedily slurps every following
    // positional until the next flag — which means the two-arg form would
    // turn the trailing taskPrompt into an additional MCP config path and
    // crash with "MCP config file not found: <prompt text>". The `=` form
    // binds the path tightly to the flag and leaves the prompt alone.
    //
    // We dedupe in case the user already put `--mcp-config` in their
    // template args (unlikely but harmless to be defensive). The dedupe
    // checks both shapes.
    const args = [...config.args];
    const hasMcpConfig = args.includes('--mcp-config') || args.some((a) => a.startsWith('--mcp-config='));
    if (!hasMcpConfig) {
      args.push(`--mcp-config=${config.mcpConfigPath}`);
    }

    // Force stream-json output so intermediate tool calls stream to stdout,
    // giving live progress visibility and keeping lastStdoutActivity alive
    // for health checks. parseOutput() already handles stream-json → clean
    // final message. Without this, `--output-format text` stays silent until
    // the task completes, making the worker appear stuck.
    //
    // Claude CLI requires `--verbose` when combining `--print` with
    // `--output-format stream-json`. Without it the CLI errors out
    // immediately with exit code 1.
    const fmtIdx = args.indexOf('--output-format');
    if (fmtIdx !== -1 && args[fmtIdx + 1] === 'text') {
      args[fmtIdx + 1] = 'stream-json';
      if (args.includes('--print') && !args.includes('--verbose')) {
        args.push('--verbose');
      }
    }
    const cmd = [config.command, ...args, config.taskPrompt];

    logger.info(
      `[ClaudeCliBackend] Spawning worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath}, mcp: ${config.mcpConfigPath})`,
    );

    return spawn({
      cmd,
      cwd: config.projectPath,
      env: {
        ...process.env,
        ...config.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  /**
   * Two credential shapes reach the same binary: an explicit key (what the
   * anthropic-compat façades supply, and what a self-hosted endpoint needs),
   * or the subscription login written by `claude auth login`. A key can be
   * checked against whichever endpoint it targets. A subscription login has
   * no free endpoint, and the CLI keeps that credential in its own store, so
   * the probe asks `claude auth status` — a local subcommand, not an agent turn.
   */
  async verifyCredentials(config: CredentialProbeConfig): Promise<CredentialProbeResult> {
    const apiKey = config.env.ANTHROPIC_API_KEY || config.env.ANTHROPIC_AUTH_TOKEN;
    if (apiKey) {
      return checkAnthropicCredential({
        baseUrl: config.env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT_BASE_URL,
        apiKey,
        credentialSource: config.env.ANTHROPIC_API_KEY ? 'env.ANTHROPIC_API_KEY' : 'env.ANTHROPIC_AUTH_TOKEN',
        timeoutMs: config.timeoutMs,
      });
    }

    return runCliAuthStatus({
      cmd: [config.command, 'auth', 'status', '--json'],
      env: config.env,
      timeoutMs: config.timeoutMs,
      credentialSource: 'claude auth status',
      interpret: ({ stdout }, exitCode) => interpretClaudeAuthStatus(stdout, exitCode),
    });
  }

  /** See `parseClaudeStreamJson` — handles both `--output-format text` and `stream-json`. */
  parseOutput(raw: string): ParsedWorkerOutput {
    return parseClaudeStreamJson(raw);
  }
}
