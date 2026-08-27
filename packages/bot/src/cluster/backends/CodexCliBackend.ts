/**
 * CodexCliBackend — spawns OpenAI Codex CLI as worker processes.
 *
 * Uses `codex exec` (non-interactive subcommand) with the prompt fed via
 * stdin (the `-` sentinel) so long/templated prompts don't hit argv limits.
 *
 * Authentication: codex resolves an `apikey`-mode `<CODEX_HOME>/auth.json`
 * ahead of `OPENAI_API_KEY`, so a stale auth.json makes every worker fail with
 * 401 no matter what template.env says. `verifyCredentials` mirrors that
 * precedence and reports which one is live.
 *
 * Project context: codex picks up `AGENTS.md` from the working directory
 * tree automatically, so per-project instructions need to live there.
 *
 * MCP wiring: codex reads MCP servers from `~/.codex/config.toml` (global,
 * single-tenant). We inject a `[mcp_servers.cluster-context-hub]` block
 * inside a marker comment fence before spawn and remove it after exit.
 * Because the file is single-tenant and the marker block is rewritten on
 * every spawn, the codex template MUST stay at maxConcurrent=1 — see
 * docs/local/agent-cluster.md §3.3.
 *
 * Session history: by using the user's global `~/.codex/` directory
 * (no `CODEX_HOME` override), all worker runs are visible in the user's
 * `codex` interactive client history.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { CredentialProbeConfig, CredentialProbeResult, WorkerBackend, WorkerSpawnConfig } from '../types';
import { checkOpenAiCredential, checkOpenAiResponsesAccess, readModelArg } from './providerCredentialCheck';

const MARKER_BEGIN = '# === cluster-managed BEGIN: do not edit between markers ===';
const MARKER_END = '# === cluster-managed END ===';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Matches a `[projects."<path>"]` table header in `config.toml`. */
const PROJECT_SECTION = /^\[projects\."([^"]*)"\]\s*$/;

/** Prefix of the throwaway workspaces `WorkerProbe` used to create via mkdtemp. */
const PROBE_WORKSPACE_PREFIX = 'cluster-probe-';

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
}

export class CodexCliBackend implements WorkerBackend {
  name = 'codex-cli';

  async spawn(config: WorkerSpawnConfig): Promise<import('bun').Subprocess> {
    // 1. Inject ContextHub MCP into ~/.codex/config.toml. Returns a
    //    cleanup closure that strips the marker block back out.
    const restoreCodexConfig = await this.injectMCPConfig(config);

    // 2. Build args: base args from template + working dir + stdin sentinel.
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

    // 3. Schedule cleanup when the process exits.
    void proc.exited.finally(() =>
      restoreCodexConfig().catch((err) => {
        logger.warn(`[CodexCliBackend] config.toml restore failed for ${config.workerId}:`, err);
      }),
    );

    return proc;
  }

  async verifyCredentials(config: CredentialProbeConfig): Promise<CredentialProbeResult> {
    const credential = await this.resolveCredential(config.env);
    if (!credential) {
      return {
        ok: false,
        credentialSource: 'none',
        reason: 'no OPENAI_API_KEY in template.env and no apikey login in auth.json — run `codex login`',
      };
    }

    const target = {
      baseUrl: config.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL,
      model: readModelArg(config.args, ['--model', '-m']),
      apiKey: credential.key,
      credentialSource: credential.source,
      timeoutMs: config.timeoutMs,
    };

    // Model entitlement first, because it names the pinned model when an
    // account cannot reach it; only then confirm the key is authorized for
    // the Responses API, which is what codex drives and which a key scoped
    // to model metadata alone would fail.
    const entitlement = await checkOpenAiCredential(target);
    const result = entitlement.ok ? await checkOpenAiResponsesAccess(target) : entitlement;

    return credential.warnings.length > 0 ? { ...result, warnings: credential.warnings } : result;
  }

  /**
   * Resolve the key codex itself would use. `auth.json` in `apikey` mode wins
   * over the environment, so a template that sets `OPENAI_API_KEY` alongside a
   * different stored login is authenticating as the stored one — worth a
   * warning, because the symptom is otherwise an unexplained 401 or a bill
   * against the wrong account.
   */
  private async resolveCredential(
    env: Record<string, string>,
  ): Promise<{ key: string; source: string; warnings: string[] } | null> {
    const authFile = join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    const envKey = env.OPENAI_API_KEY;

    let stored: CodexAuthFile | null = null;
    try {
      stored = JSON.parse(await readFile(authFile, 'utf-8')) as CodexAuthFile;
    } catch {
      stored = null;
    }

    const storedKey = stored?.auth_mode === 'apikey' ? stored.OPENAI_API_KEY : undefined;
    if (storedKey) {
      const warnings =
        envKey && envKey !== storedKey
          ? [`template.env.OPENAI_API_KEY is ignored — codex authenticates with the apikey login in ${authFile}`]
          : [];
      return { key: storedKey, source: authFile, warnings };
    }

    if (envKey) return { key: envKey, source: 'env.OPENAI_API_KEY', warnings: [] };
    return null;
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
  private async injectMCPConfig(config: WorkerSpawnConfig): Promise<() => Promise<void>> {
    const dir = join(homedir(), '.codex');
    const file = join(dir, 'config.toml');

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    let original = '';
    if (existsSync(file)) {
      original = await readFile(file, 'utf-8');
    }

    // Strip any pre-existing marker block (left over from a prior run that
    // crashed before its restore closure could fire).
    const stripped = this.stripMarkerBlock(original);

    // Build the new marker block. Codex TOML uses [mcp_servers.<name>] for
    // each server. http_headers is a TOML inline table.
    const mcpUrl = `${config.hubUrl}/mcp`;
    const block = [
      MARKER_BEGIN,
      '[mcp_servers.cluster-context-hub]',
      `url = "${mcpUrl}"`,
      `http_headers = { "X-Worker-Id" = "${config.workerId}" }`,
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 60',
      'enabled = true',
      MARKER_END,
      '',
    ].join('\n');

    // Append the marker block (with a leading newline if the existing
    // content doesn't end in one).
    const sep = stripped.length > 0 && !stripped.endsWith('\n') ? '\n\n' : stripped.length > 0 ? '\n' : '';
    await writeFile(file, stripped + sep + block);

    // Return a closure that strips the marker block back out.
    return async () => {
      try {
        const current = existsSync(file) ? await readFile(file, 'utf-8') : '';
        const cleaned = this.stripMarkerBlock(current);
        if (cleaned.length === 0 && original.length === 0) {
          // We created the file ourselves (it was empty before) and now
          // it would be empty again. Leave it as an empty file rather than
          // deleting — codex tooling may expect ~/.codex/config.toml to
          // exist in some flows.
          await writeFile(file, '');
        } else {
          await writeFile(file, cleaned);
        }
      } catch (err) {
        logger.warn(`[CodexCliBackend] Failed to clean marker block from ${file}:`, err);
      }
    };
  }

  /**
   * Remove a marker-fenced block (and its surrounding blank line if any)
   * from the given TOML text. Idempotent: returns input unchanged if no
   * marker block is present.
   */
  private stripMarkerBlock(text: string): string {
    const beginIdx = text.indexOf(MARKER_BEGIN);
    if (beginIdx === -1) return text;
    const endIdx = text.indexOf(MARKER_END, beginIdx);
    if (endIdx === -1) return text; // malformed; leave alone
    const after = endIdx + MARKER_END.length;
    let before = text.slice(0, beginIdx);
    let rest = text.slice(after);
    // Trim a single trailing newline from `before` and a single leading
    // newline from `rest` so we don't accumulate blank lines on repeated
    // inject/restore cycles.
    if (before.endsWith('\n\n')) before = before.slice(0, -1);
    else if (before.endsWith('\n')) before = before.slice(0, -1);
    if (rest.startsWith('\n')) rest = rest.slice(1);
    return (before + (before && rest && !before.endsWith('\n') ? '\n' : '') + rest).replace(/\n{3,}/g, '\n\n');
  }
}
