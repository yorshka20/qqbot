/**
 * GeminiCliBackend — spawns Google Gemini CLI as worker processes.
 *
 * Uses `gemini -p <prompt>` (the `--prompt` flag forces non-interactive mode).
 * The CLI has no `--cwd` switch — workspace root is the spawn cwd.
 *
 * Authentication: requires `GEMINI_API_KEY` (or `GOOGLE_API_KEY` +
 * `GOOGLE_CLOUD_PROJECT` for Vertex AI) in template.env. No login flow
 * needed for headless workers.
 *
 * Project context: Gemini reads `GEMINI.md` from the workspace tree
 * automatically.
 *
 * MCP wiring: like ClaudeCliBackend / CodexCliBackend, we do NOT inject
 * ContextHub MCP into `~/.gemini/settings.json` here — see workbook
 * 2026-04-10 for the cluster-wide MCP wiring gap.
 *
 * Tool auto-approval: pass `--approval-mode=yolo` in template.args
 * (the equivalent of claude's `--dangerously-skip-permissions`).
 */

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { WorkerBackend, WorkerSpawnConfig } from '../types';

export class GeminiCliBackend implements WorkerBackend {
  name = 'gemini-cli';

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // Gemini takes the prompt via `-p`/`--prompt` argv. Long prompts work
    // fine on POSIX (ARG_MAX is hundreds of KB), and stdin support is less
    // documented than for codex, so argv is the safer default here.
    const args = [...config.args, '-p', config.taskPrompt];

    logger.info(
      `[GeminiCliBackend] Spawning worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath})`,
    );

    return spawn({
      cmd: [config.command, ...args],
      cwd: config.projectPath,
      env: {
        ...process.env,
        ...config.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }
}
