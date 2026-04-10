/**
 * CodexCliBackend — spawns OpenAI Codex CLI as worker processes.
 *
 * Uses `codex exec` (non-interactive subcommand) with the prompt fed via
 * stdin (the `-` sentinel) so long/templated prompts don't hit argv limits.
 *
 * Authentication: requires `OPENAI_API_KEY` in template.env (codex CLI also
 * supports interactive `codex login`, but workers run headless).
 *
 * Project context: codex picks up `AGENTS.md` from the working directory
 * tree automatically, so per-project instructions need to live there.
 *
 * MCP wiring: codex reads `~/.codex/config.toml` for MCP servers. We do
 * NOT inject ContextHub here — see workbook 2026-04-10 for the MCP wiring
 * gap that exists across all backends. Workers run autonomously and
 * communicate task outcomes via stdout exit code (matching ClaudeCliBackend).
 *
 * Session history: by using the user's global `~/.codex/` directory
 * (no `CODEX_HOME` override), all worker runs are visible in the user's
 * `codex` interactive client history.
 */

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { WorkerBackend, WorkerSpawnConfig } from '../types';

export class CodexCliBackend implements WorkerBackend {
  name = 'codex-cli';

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // Build args: base args from template + working dir + stdin sentinel.
    // Template default: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
    const args = [...config.args, '--cd', config.projectPath, '-'];

    logger.info(`[CodexCliBackend] Spawning worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath})`);

    const proc = spawn({
      cmd: [config.command, ...args],
      cwd: config.projectPath,
      env: {
        ...process.env,
        ...config.env,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Feed prompt via stdin and close.
    try {
      const stdin = proc.stdin;
      if (stdin && typeof (stdin as { write?: unknown }).write === 'function') {
        // Bun's stdin is a FileSink with sync write/end.
        (stdin as { write: (chunk: string) => void }).write(config.taskPrompt);
        (stdin as { end: () => void }).end();
      }
    } catch (err) {
      logger.error(`[CodexCliBackend] Failed to write prompt to stdin for ${config.workerId}:`, err);
    }

    return proc;
  }
}
