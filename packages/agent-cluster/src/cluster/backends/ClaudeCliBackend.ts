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
import type {
  CredentialProbeConfig,
  CredentialProbeResult,
  ParsedWorkerOutput,
  WorkerBackend,
  WorkerLaunch,
  WorkerSpawnConfig,
} from '../types';
import { checkAnthropicCredential, interpretClaudeAuthStatus, runCliAuthStatus } from './providerCredentialCheck';

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

function readSessionIdArg(args: string[]): string | undefined {
  const idx = args.indexOf('--session-id');
  if (idx !== -1) return args[idx + 1];
  return args.find((a) => a.startsWith('--session-id='))?.slice('--session-id='.length);
}

export class ClaudeCliBackend implements WorkerBackend {
  name = 'claude-cli';

  async launch(config: WorkerSpawnConfig): Promise<WorkerLaunch> {
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

    // Choose the session id up front so the task knows it before the first line of output.
    let sessionId = readSessionIdArg(args);
    if (!sessionId) {
      sessionId = randomUUID();
      args.push('--session-id', sessionId);
    }

    logger.info(
      `[ClaudeCliBackend] Launching worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath}, mcp: ${config.mcpConfigPath}, session: ${sessionId})`,
    );

    return {
      cmd: [config.command, ...args, config.taskPrompt],
      cwd: config.projectPath,
      env: config.env,
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
