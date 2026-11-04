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
 * a fresh settings.json before launch (backing up any existing one) and
 * restore the original after the worker exits. The restore runs only while
 * the scheduler that launched the worker is alive: after a scheduler restart
 * the injected entry stays in settings.json until the next gemini launch
 * rewrites it.
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
import { logger } from '@qqbot/shared';
import type {
  CredentialProbeConfig,
  CredentialProbeResult,
  WorkerBackend,
  WorkerLaunch,
  WorkerSpawnConfig,
} from '../types';
import { checkGeminiCredential, readModelArg } from './providerCredentialCheck';

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiCliBackend implements WorkerBackend {
  name = 'gemini-cli';

  async launch(config: WorkerSpawnConfig): Promise<WorkerLaunch> {
    const cleanup = await this.injectMCPSettings(config);
    logger.info(
      `[GeminiCliBackend] Launching worker ${config.workerId}: ${config.command} (cwd: ${config.projectPath})`,
    );
    return {
      cmd: [config.command, ...config.args, '-p', config.taskPrompt],
      cwd: config.projectPath,
      env: config.env,
      cleanup,
    };
  }

  async verifyCredentials(config: CredentialProbeConfig): Promise<CredentialProbeResult> {
    const apiKey = config.env.GEMINI_API_KEY || config.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        credentialSource: 'none',
        reason: 'neither GEMINI_API_KEY nor GOOGLE_API_KEY is set in template.env',
      };
    }

    return checkGeminiCredential({
      baseUrl: GEMINI_DEFAULT_BASE_URL,
      model: readModelArg(config.args, ['-m', '--model']),
      apiKey,
      credentialSource: config.env.GEMINI_API_KEY ? 'env.GEMINI_API_KEY' : 'env.GOOGLE_API_KEY',
      timeoutMs: config.timeoutMs,
    });
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
