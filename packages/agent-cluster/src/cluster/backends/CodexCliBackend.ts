/**
 * CodexCliBackend — runs the OpenAI Codex CLI as worker processes.
 *
 * Uses `codex exec` (non-interactive subcommand) with the prompt fed via
 * stdin (the `-` sentinel) so long/templated prompts don't hit argv limits.
 *
 * Authentication: ChatGPT login only. API-key variables are stripped from
 * the worker environment (see `withoutCodexApiKeys`) and `verifyCredentials`
 * rejects an API-key login reported by `codex login status`.
 *
 * Project context: codex picks up `AGENTS.md` from the working directory
 * tree automatically, so per-project instructions need to live there.
 *
 * MCP wiring: the hub is registered per process with `-c mcp_servers.*`
 * overrides (`codexMcpServerArgs`), so concurrent codex workers each carry
 * their own `X-Worker-Id` and nothing is written to `~/.codex/config.toml`.
 *
 * Session history: by using the user's global `~/.codex/` directory
 * (no `CODEX_HOME` override), all worker runs are visible in the user's
 * `codex` interactive client history, and `codex exec resume <thread id>`
 * can continue one.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { logger } from '@qqbot/shared';
import { codexMcpServerArgs, withoutCodexApiKeys } from '../../cli/codexCli';
import type {
  CredentialProbeConfig,
  CredentialProbeResult,
  WorkerBackend,
  WorkerLaunch,
  WorkerResumeConfig,
  WorkerSpawnConfig,
} from '../types';
import { interpretCodexLoginStatus, runCliAuthStatus } from './providerCredentialCheck';

/** Matches a `[projects."<path>"]` table header in `config.toml`. */
const PROJECT_SECTION = /^\[projects\."([^"]*)"\]\s*$/;

/** Prefix of the throwaway workspaces `WorkerProbe` used to create via mkdtemp. */
const PROBE_WORKSPACE_PREFIX = 'cluster-probe-';

export class CodexCliBackend implements WorkerBackend {
  name = 'codex-cli';

  async launch(config: WorkerSpawnConfig): Promise<WorkerLaunch> {
    // Template default args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
    const args = [...config.args, ...this.processArgs(config), '-'];

    logger.info(
      `[CodexCliBackend] Launching worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath})`,
    );

    return {
      cmd: [config.command, ...args],
      cwd: config.projectPath,
      env: this.workerEnv(config),
      stdin: config.taskPrompt,
    };
  }

  /**
   * `codex exec resume <thread id> -` continues the thread with the prompt on stdin. The
   * subcommand goes right after `exec`; the template's other flags are accepted by `resume` too.
   */
  async resume(config: WorkerResumeConfig): Promise<WorkerLaunch> {
    const [exec, ...rest] = config.args;
    const args = [exec, 'resume', ...rest, ...this.processArgs(config), config.sessionId, '-'];

    logger.info(
      `[CodexCliBackend] Resuming worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath}, thread: ${config.sessionId})`,
    );

    return {
      cmd: [config.command, ...args],
      cwd: config.projectPath,
      env: this.workerEnv(config),
      stdin: config.taskPrompt,
      sessionId: config.sessionId,
    };
  }

  private processArgs(config: WorkerSpawnConfig): string[] {
    return [
      ...codexMcpServerArgs('cluster-context-hub', `${config.hubUrl}/mcp`, { 'X-Worker-Id': config.workerId }),
      '--cd',
      config.projectPath,
    ];
  }

  private workerEnv(config: WorkerSpawnConfig): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(withoutCodexApiKeys(config.env))) {
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  /** `codex exec --json` announces its thread as `{"type":"thread.started","thread_id":"…"}`. */
  sessionIdFrom(line: string): string | undefined {
    if (!line.includes('thread.started')) return undefined;
    try {
      const evt = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      return evt.type === 'thread.started' && typeof evt.thread_id === 'string' ? evt.thread_id : undefined;
    } catch {
      return undefined;
    }
  }

  async verifyCredentials(config: CredentialProbeConfig): Promise<CredentialProbeResult> {
    return runCliAuthStatus({
      cmd: [config.command, 'login', 'status'],
      env: withoutCodexApiKeys(config.env),
      timeoutMs: config.timeoutMs,
      credentialSource: 'codex login status',
      interpret: ({ stdout, stderr }, exitCode) => interpretCodexLoginStatus(`${stdout}\n${stderr}`, exitCode),
    });
  }

  /**
   * Drop `[projects."…/cluster-probe-*"]` entries from `config.toml`.
   *
   * codex records every working directory it is pointed at as a trusted
   * project and never prunes them, so each probe that ran in a throwaway
   * mkdtemp workspace left a permanent entry behind in the user's own codex
   * config. Probing no longer spawns the CLI, so this only has to clear what
   * earlier runs accumulated; it is idempotent and cheap enough to run at
   * every cluster start.
   */
  static async cleanupProbeWorkspaces(codexHome?: string): Promise<number> {
    const file = join(codexHome || join(homedir(), '.codex'), 'config.toml');
    if (!existsSync(file)) return 0;

    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch (err) {
      logger.warn(`[CodexCliBackend] Could not read ${file} for probe-workspace cleanup:`, err);
      return 0;
    }

    const kept: string[] = [];
    let removed = 0;
    let skipping = false;
    for (const line of content.split('\n')) {
      if (line.startsWith('[')) {
        const match = PROJECT_SECTION.exec(line);
        skipping = match !== null && basename(match[1]).startsWith(PROBE_WORKSPACE_PREFIX);
        if (skipping) removed++;
      }
      if (!skipping) kept.push(line);
    }

    if (removed === 0) return 0;

    try {
      await writeFile(file, kept.join('\n').replace(/\n{3,}/g, '\n\n'));
    } catch (err) {
      logger.warn(`[CodexCliBackend] Could not rewrite ${file} during probe-workspace cleanup:`, err);
      return 0;
    }

    logger.info(`[CodexCliBackend] Removed ${removed} stale probe workspace entr(ies) from ${file}`);
    return removed;
  }

  /**
   * Inject the cluster ContextHub MCP server entry into `~/.codex/config.toml`
   * inside a marker block, so we can strip it back out cleanly after the
   * worker exits without disturbing the rest of the user's codex config.
   *
   * Strategy: read existing config.toml → strip any prior marker block →
   * append a fresh marker block containing the current worker's hub URL +
   * X-Worker-Id header → write. Restore = strip marker block again.
   *
   * Idempotent across spawns: every spawn fully rewrites the marker block,
   * so a crashed prior worker leaving stale markers is handled gracefully.
   */
}
