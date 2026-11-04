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

import { logger, randomUUID } from '@qqbot/shared';
import { parseClaudeStreamJson } from '../../cli/claudeStreamJson';
import { MCP_TOOL_CALL_TIMEOUT_MS } from '../hub/waitWindow';
import type {
  CredentialProbeConfig,
  CredentialProbeResult,
  ParsedWorkerOutput,
  UsageSample,
  WorkerBackend,
  WorkerLaunch,
  WorkerResumeConfig,
  WorkerSpawnConfig,
} from '../types';
import { checkAnthropicCredential, interpretClaudeAuthStatus, runCliAuthStatus } from './providerCredentialCheck';

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

function readSessionIdArg(args: string[]): string | undefined {
  const idx = args.indexOf('--session-id');
  if (idx !== -1) return args[idx + 1];
  return args.find((a) => a.startsWith('--session-id='))?.slice('--session-id='.length);
}

function withoutSessionIdArg(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session-id') {
      i++;
      continue;
    }
    if (arg.startsWith('--session-id=')) continue;
    out.push(arg);
  }
  return out;
}

export class ClaudeCliBackend implements WorkerBackend {
  name = 'claude-cli';

  async launch(config: WorkerSpawnConfig): Promise<WorkerLaunch> {
    const args = this.commonArgs(config);

    // Choose the session id up front so the task knows it before the first line of output.
    let sessionId = readSessionIdArg(args);
    if (!sessionId) {
      sessionId = randomUUID();
      args.push('--session-id', sessionId);
    }

    logger.info(
      `[ClaudeCliBackend] Launching worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath}, mcp: ${config.mcpConfigPath}, session: ${sessionId})`,
    );

    return this.launchWith(config, args, sessionId);
  }

  /**
   * `--resume <id>` continues the session the first run created; claude finds it by the cwd, so
   * the worker must start where the session was created. The template's own `--session-id`, if
   * any, is dropped: it would start a fresh session under that id.
   */
  async resume(config: WorkerResumeConfig): Promise<WorkerLaunch> {
    const args = withoutSessionIdArg(this.commonArgs(config));
    args.push('--resume', config.sessionId);

    logger.info(
      `[ClaudeCliBackend] Resuming worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath}, session: ${config.sessionId})`,
    );

    return this.launchWith(config, args, config.sessionId);
  }

  private commonArgs(config: WorkerSpawnConfig): string[] {
    const args = [...config.args];
    const hasMcpConfig = args.includes('--mcp-config') || args.some((a) => a.startsWith('--mcp-config='));
    if (!hasMcpConfig) {
      // `--mcp-config=<path>` as one argument: the two-argument form is a multi-value option
      // that would swallow the trailing prompt as another config path.
      args.push(`--mcp-config=${config.mcpConfigPath}`);
    }

    const fmtIdx = args.indexOf('--output-format');
    if (fmtIdx !== -1 && args[fmtIdx + 1] === 'text') {
      args[fmtIdx + 1] = 'stream-json';
      if (args.includes('--print') && !args.includes('--verbose')) {
        args.push('--verbose');
      }
    }
    return args;
  }

  private launchWith(config: WorkerSpawnConfig, args: string[], sessionId: string): WorkerLaunch {
    return {
      cmd: [config.command, ...args, config.taskPrompt],
      cwd: config.projectPath,
      env: { MCP_TOOL_TIMEOUT: String(MCP_TOOL_CALL_TIMEOUT_MS), ...config.env },
      sessionId,
    };
  }

  /** stream-json names the model on the `system/init` event and on every assistant message. */
  modelFrom(line: string): string | undefined {
    if (!line.includes('"model"')) return undefined;
    try {
      const evt = JSON.parse(line) as { model?: unknown; message?: { model?: unknown } };
      const model = evt.message?.model ?? evt.model;
      return typeof model === 'string' && model ? model : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * stream-json reports usage per request on every assistant message, and the run's totals
   * (with turns and cost) on the final `result` event.
   */
  usageFrom(line: string): UsageSample | undefined {
    if (!line.includes('"usage"')) return undefined;
    try {
      const evt = JSON.parse(line) as {
        type?: unknown;
        usage?: Record<string, unknown>;
        message?: { usage?: Record<string, unknown> };
        num_turns?: unknown;
        total_cost_usd?: unknown;
      };
      const final = evt.type === 'result';
      const usage = final ? evt.usage : evt.type === 'assistant' ? evt.message?.usage : undefined;
      if (!usage) return undefined;
      const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
      return {
        input: n('input_tokens'),
        output: n('output_tokens'),
        cacheRead: n('cache_read_input_tokens'),
        cacheCreation: n('cache_creation_input_tokens'),
        ...(final && typeof evt.num_turns === 'number' ? { turns: evt.num_turns } : {}),
        ...(final && typeof evt.total_cost_usd === 'number' ? { costUsd: evt.total_cost_usd } : {}),
        ...(final ? { final: true } : {}),
      };
    } catch {
      return undefined;
    }
  }

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
