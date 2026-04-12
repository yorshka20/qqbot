/**
 * WorkerTemplateHealthCheck — validates worker template availability at
 * cluster startup.
 *
 * For each configured workerTemplate, checks:
 *   1. CLI binary exists and is reachable (via Bun.which)
 *   2. Binary is functional (via `<binary> --version` or equivalent)
 *   3. Template-specific env vars that ARE required (e.g. minimax-cli
 *      needs ANTHROPIC_API_KEY because it's a façade over claude binary
 *      with a custom base URL)
 *
 * NOTE: claude-cli / codex-cli / gemini-cli each have their own built-in
 * auth mechanisms (login, config files, etc.). We do NOT check for API key
 * env vars for these backends — they handle auth internally at spawn time.
 * Only minimax-cli requires an explicit key in template.env because it
 * redirects the claude binary to a third-party endpoint.
 *
 * Results are logged as warnings; unavailable templates do NOT block startup.
 */

import { spawn } from 'bun';
import { logger } from '@/utils/logger';
import type { ClusterConfig, WorkerBackendType, WorkerTemplateConfig } from './config';

export interface TemplateHealthResult {
  templateName: string;
  available: boolean;
  binaryFound: boolean;
  binaryVersion?: string;
  envOk: boolean;
  warnings: string[];
}

/**
 * Per-backend-type requirements.
 *
 * `requiredEnvVars`: env vars that MUST be present in template.env for this
 * backend to work. Empty for CLIs with built-in auth.
 */
interface BackendRequirements {
  binary: string;
  versionArgs: string[];
  requiredEnvVars: string[];
}

const BACKEND_REQUIREMENTS: Record<WorkerBackendType, BackendRequirements> = {
  'claude-cli': {
    binary: 'claude',
    versionArgs: ['--version'],
    requiredEnvVars: [], // claude CLI has built-in auth
  },
  'codex-cli': {
    binary: 'codex',
    versionArgs: ['--version'],
    requiredEnvVars: [], // codex CLI has built-in auth
  },
  'gemini-cli': {
    binary: 'gemini',
    versionArgs: ['--version'],
    requiredEnvVars: [], // gemini CLI has built-in auth
  },
  'minimax-cli': {
    binary: 'claude', // façade over claude binary
    versionArgs: ['--version'],
    // minimax-cli redirects claude to MiniMax's endpoint — an explicit
    // API key in template.env is mandatory (no built-in auth for MiniMax).
    requiredEnvVars: ['ANTHROPIC_API_KEY'],
  },
};

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('replace') || lower === 'sk-...' || lower === 'your-api-key';
}

/** Timeout for `--version` probes (ms). CLI tools like claude/gemini may
 *  perform auth checks on startup, so keep this short to avoid blocking. */
const VERSION_TIMEOUT_MS = 3_000;

async function checkBinaryVersion(
  binaryName: string,
  versionArgs: string[],
): Promise<{ found: boolean; version?: string }> {
  const resolved = Bun.which(binaryName);
  if (!resolved) return { found: false };

  try {
    const proc = spawn({
      cmd: [binaryName, ...versionArgs],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Race against timeout — don't let a slow CLI block startup
    const exited = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), VERSION_TIMEOUT_MS)),
    ]);

    if (exited === 'timeout') {
      proc.kill();
      return { found: true, version: '(version check timed out)' };
    }

    if (exited === 0) {
      const stdout = await new Response(proc.stdout).text();
      const version = stdout.trim().split('\n')[0]?.slice(0, 80);
      return { found: true, version };
    }
    // Binary exists but --version failed — still counts as found
    return { found: true };
  } catch {
    // spawn failed — binary may exist but not be executable
    return { found: !!resolved };
  }
}

function checkRequiredEnv(
  requirements: BackendRequirements,
  template: WorkerTemplateConfig,
): { ok: boolean; warnings: string[] } {
  if (requirements.requiredEnvVars.length === 0) {
    return { ok: true, warnings: [] };
  }

  const warnings: string[] = [];
  for (const envVar of requirements.requiredEnvVars) {
    const value = template.env?.[envVar];
    if (!value) {
      warnings.push(`template.env.${envVar} is required but not set`);
      return { ok: false, warnings };
    }
    if (isPlaceholder(value)) {
      warnings.push(`template.env.${envVar} appears to be a placeholder`);
      return { ok: false, warnings };
    }
  }
  return { ok: true, warnings };
}

async function checkTemplate(
  name: string,
  template: WorkerTemplateConfig,
  binaryCache: Map<string, { found: boolean; version?: string }>,
): Promise<TemplateHealthResult> {
  const type = template.type || 'claude-cli';
  const requirements = BACKEND_REQUIREMENTS[type];
  const warnings: string[] = [];

  // 1. Binary check (cached per binary name)
  const binaryName = template.command || requirements.binary;
  if (!binaryCache.has(binaryName)) {
    binaryCache.set(binaryName, await checkBinaryVersion(binaryName, requirements.versionArgs));
  }
  const binaryResult = binaryCache.get(binaryName)!;
  if (!binaryResult.found) {
    warnings.push(`Binary '${binaryName}' not found in PATH`);
  }

  // 2. Required env check (only for backends that need explicit keys)
  const envResult = checkRequiredEnv(requirements, template);
  warnings.push(...envResult.warnings);

  return {
    templateName: name,
    available: binaryResult.found && envResult.ok,
    binaryFound: binaryResult.found,
    binaryVersion: binaryResult.version,
    envOk: envResult.ok,
    warnings,
  };
}

/**
 * Run health checks for all worker templates in the cluster config.
 * Returns per-template results and logs a summary.
 */
export async function checkWorkerTemplateHealth(config: ClusterConfig): Promise<TemplateHealthResult[]> {
  // Pre-resolve all unique binaries in parallel (each may take up to VERSION_TIMEOUT_MS)
  const binaryCache = new Map<string, { found: boolean; version?: string }>();
  const binaryNames = new Set<string>();
  for (const tpl of Object.values(config.workerTemplates)) {
    const type = tpl.type || 'claude-cli';
    binaryNames.add(tpl.command || BACKEND_REQUIREMENTS[type].binary);
  }
  await Promise.all(
    [...binaryNames].map(async (name) => {
      const type = Object.values(BACKEND_REQUIREMENTS).find((r) => r.binary === name);
      const result = await checkBinaryVersion(name, type?.versionArgs ?? ['--version']);
      binaryCache.set(name, result);
    }),
  );

  // Template checks are now synchronous (binary results cached, env is pure config read)
  const results: TemplateHealthResult[] = [];
  for (const [name, template] of Object.entries(config.workerTemplates)) {
    results.push(await checkTemplate(name, template, binaryCache));
  }

  // Log summary
  const available = results.filter((r) => r.available);
  const unavailable = results.filter((r) => !r.available);

  if (available.length > 0) {
    const lines = available.map((r) => {
      const role = config.workerTemplates[r.templateName].role || 'executor';
      const ver = r.binaryVersion ? ` [${r.binaryVersion}]` : '';
      return `  ✓ ${r.templateName} (${role})${ver}`;
    });
    logger.info(`[ClusterHealthCheck] ${available.length} template(s) ready:\n${lines.join('\n')}`);
  }

  if (unavailable.length > 0) {
    const lines = unavailable.map((r) => {
      const issues = r.warnings.join('; ');
      return `  ✗ ${r.templateName}: ${issues}`;
    });
    logger.warn(`[ClusterHealthCheck] ${unavailable.length} template(s) NOT ready:\n${lines.join('\n')}`);
  }

  return results;
}
