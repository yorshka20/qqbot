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
 * MCP wiring: Gemini reads MCP server config from `<projectPath>/.gemini/settings.json`
 * (per-project, takes precedence over `~/.gemini/settings.json`). We write
 * a fresh settings.json before spawn (backing up any existing one) and
 * restore the original after the worker exits. This means gemini workers
 * can use the cluster ContextHub via the standard MCP tools/call protocol.
 *
 * Concurrency: gemini-cli template MUST stay at maxConcurrent=1 because
 * the per-project settings.json is single-tenant. Multiple concurrent
 * gemini workers in the same project would race on the file. See
 * docs/local/agent-cluster.md §3.3.
 *
 * Tool auto-approval: pass `--approval-mode=yolo` in template.args
 * (the equivalent of claude's `--dangerously-skip-permissions`).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { WorkerBackend, WorkerSpawnConfig } from '../types';

export class GeminiCliBackend implements WorkerBackend {
  name = 'gemini-cli';

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // 1. Inject ContextHub MCP into ./.gemini/settings.json. We back up any
    //    existing settings file so the user's per-project gemini config
    //    survives the worker run.
    const settingsRestore = await this.injectMCPSettings(config);

    // 2. Build args and spawn the worker.
    // Gemini takes the prompt via `-p`/`--prompt` argv. Long prompts work
    // fine on POSIX (ARG_MAX is hundreds of KB), and stdin support is less
    // documented than for codex, so argv is the safer default here.
    const args = [...config.args, '-p', config.taskPrompt];

    logger.info(
      `[GeminiCliBackend] Spawning worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath})`,
    );

    const proc = spawn({
      cmd: [config.command, ...args],
      cwd: config.projectPath,
      env: {
        ...process.env,
        ...config.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // 3. Schedule cleanup when the process exits, regardless of how it
    //    exited (success / failure / kill). Fire-and-forget — the
    //    `monitorProcess` in WorkerPool waits on `proc.exited` separately.
    void proc.exited.finally(() =>
      settingsRestore().catch((err) => {
        logger.warn(`[GeminiCliBackend] settings.json restore failed for ${config.workerId}:`, err);
      }),
    );

    return proc;
  }

  /**
   * Inject the cluster ContextHub MCP server entry into
   * `<projectPath>/.gemini/settings.json`. Returns a restore function the
   * caller schedules on `proc.exited`.
   *
   * Strategy: read existing settings.json (if any) → save its raw bytes
   * for restore → merge our MCP entry → write. On restore, write back
   * the original bytes verbatim (or delete the file if it didn't exist
   * before).
   */
  private async injectMCPSettings(config: WorkerSpawnConfig): Promise<() => Promise<void>> {
    const dir = join(config.projectPath, '.gemini');
    const file = join(dir, 'settings.json');

    let originalBytes: string | null = null;
    let dirCreated = false;
    if (existsSync(file)) {
      originalBytes = await readFile(file, 'utf-8');
    } else if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      dirCreated = true;
    }

    // Parse existing settings (if any) so we can merge mcpServers in
    // without dropping unrelated keys (model name, theme, etc.).
    let merged: Record<string, unknown> = {};
    if (originalBytes) {
      try {
        merged = JSON.parse(originalBytes) as Record<string, unknown>;
      } catch {
        logger.warn(
          `[GeminiCliBackend] Existing ${file} is not valid JSON; overwriting (will restore original bytes after worker exits)`,
        );
        merged = {};
      }
    }

    const existingServers = (merged.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = {
      ...existingServers,
      'cluster-context-hub': {
        // Gemini settings.json uses `httpUrl` for HTTP MCP transport.
        httpUrl: `${config.hubUrl}/mcp`,
        headers: {
          'X-Worker-Id': config.workerId,
        },
        timeout: 5000,
      },
    };

    await writeFile(file, JSON.stringify(merged, null, 2));

    // Return a restore closure capturing the original bytes / dir state.
    return async () => {
      try {
        if (originalBytes !== null) {
          await writeFile(file, originalBytes);
        } else {
          await rm(file, { force: true });
          if (dirCreated) {
            // Best-effort cleanup of the .gemini directory if we created it.
            // rm with recursive may fail if the user added other files —
            // that's fine, leave them alone.
            await rm(dir, { recursive: false }).catch(() => undefined);
          }
        }
      } catch (err) {
        logger.warn(`[GeminiCliBackend] Failed to restore ${file}:`, err);
      }
    };
  }
}
