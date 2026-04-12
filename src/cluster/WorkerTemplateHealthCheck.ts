/**
 * WorkerTemplateHealthCheck — validates worker template availability at
 * cluster startup.
 *
 * For each configured workerTemplate, checks:
 *   1. CLI binary exists and is reachable (via Bun.which / spawn --version)
 *   2. Required API key env vars are present (template.env or process.env)
 *
 * Results are logged as warnings; unavailable templates do NOT block startup
 * but are surfaced clearly so operators can fix config before dispatching.
 */

import { logger } from '@/utils/logger';
import type { ClusterConfig, WorkerBackendType, WorkerTemplateConfig } from './config';

export interface TemplateHealthResult {
  templateName: string;
  available: boolean;
  binaryFound: boolean;
  apiKeyPresent: boolean;
  binaryPath?: string;
  warnings: string[];
}

/**
 * Per-backend-type: which binary to look for and which env var(s) constitute
 * the "API key" requirement.
 */
interface BackendRequirements {
  /** Binary name to resolve via Bun.which(). */
  binary: string;
  /**
   * Env var names to check. At least ONE must be present (in template.env
   * or process.env) for the template to be considered configured.
   * For backends that inherit from process.env (claude-cli), the key may
   * already be set globally.
   */
  apiKeyEnvVars: string[];
}

const BACKEND_REQUIREMENTS: Record<WorkerBackendType, BackendRequirements> = {
  'claude-cli': {
    binary: 'claude',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
  },
  'codex-cli': {
    binary: 'codex',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
  },
  'gemini-cli': {
    binary: 'gemini',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  'minimax-cli': {
    // minimax-cli is a façade over claude binary
    binary: 'claude',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
  },
};

function resolveEnvVar(name: string, templateEnv?: Record<string, string>): string | undefined {
  return templateEnv?.[name] || process.env[name];
}

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith('replace') || lower === 'sk-...' || lower === 'your-api-key' || lower.includes('replace');
}

async function checkBinary(name: string): Promise<{ found: boolean; path?: string }> {
  const resolved = Bun.which(name);
  if (resolved) {
    return { found: true, path: resolved };
  }
  return { found: false };
}

function checkApiKey(
  requirements: BackendRequirements,
  template: WorkerTemplateConfig,
): { present: boolean; warnings: string[] } {
  const warnings: string[] = [];

  for (const envVar of requirements.apiKeyEnvVars) {
    const value = resolveEnvVar(envVar, template.env);
    if (value && !isPlaceholder(value)) {
      return { present: true, warnings };
    }
    if (value && isPlaceholder(value)) {
      warnings.push(`${envVar} is set but appears to be a placeholder`);
    }
  }

  warnings.push(
    `Missing API key: need one of [${requirements.apiKeyEnvVars.join(', ')}] in template env or process.env`,
  );
  return { present: false, warnings };
}

/**
 * Check a single worker template's readiness.
 */
async function checkTemplate(
  name: string,
  template: WorkerTemplateConfig,
  binaryCache: Map<string, { found: boolean; path?: string }>,
): Promise<TemplateHealthResult> {
  const type = template.type || 'claude-cli';
  const requirements = BACKEND_REQUIREMENTS[type];
  const warnings: string[] = [];

  // 1. Binary check (cached per binary name since multiple templates may share one)
  const binaryName = template.command || requirements.binary;
  if (!binaryCache.has(binaryName)) {
    binaryCache.set(binaryName, await checkBinary(binaryName));
  }
  const binaryResult = binaryCache.get(binaryName)!;
  if (!binaryResult.found) {
    warnings.push(`Binary '${binaryName}' not found in PATH`);
  }

  // 2. API key check
  const apiKeyResult = checkApiKey(requirements, template);
  warnings.push(...apiKeyResult.warnings);

  return {
    templateName: name,
    available: binaryResult.found && apiKeyResult.present,
    binaryFound: binaryResult.found,
    apiKeyPresent: apiKeyResult.present,
    binaryPath: binaryResult.path,
    warnings,
  };
}

/**
 * Run health checks for all worker templates in the cluster config.
 * Returns per-template results and logs a summary.
 */
export async function checkWorkerTemplateHealth(config: ClusterConfig): Promise<TemplateHealthResult[]> {
  const results: TemplateHealthResult[] = [];
  const binaryCache = new Map<string, { found: boolean; path?: string }>();

  for (const [name, template] of Object.entries(config.workerTemplates)) {
    results.push(await checkTemplate(name, template, binaryCache));
  }

  // Log summary
  const available = results.filter((r) => r.available);
  const unavailable = results.filter((r) => !r.available);

  if (available.length > 0) {
    const lines = available.map((r) => {
      const role = config.workerTemplates[r.templateName].role || 'executor';
      return `  ✓ ${r.templateName} (${role})`;
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
