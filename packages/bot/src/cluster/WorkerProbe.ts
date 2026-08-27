/**
 * WorkerProbe — credential check for worker templates.
 *
 * WorkerTemplateHealthCheck only validates static preconditions (binary on
 * PATH, required env vars present) — it never confirms the credential behind a
 * template still works, so expired CLI logins, revoked keys, wrong base URLs
 * and models an account cannot reach stay invisible until a real ticket
 * dispatches and fails. probeWorkerTemplates closes that gap by asking each
 * template's provider directly through `WorkerBackend.verifyCredentials`.
 *
 * Nothing is spawned. An agent CLI ships its entire system prompt and tool
 * schema on every invocation, so a spawn-based probe costs a full paid model
 * call per template per cluster start — for a question the provider answers
 * for free. Whether the CLI harness itself works is a separate, near-static
 * property already covered by the binary check.
 *
 * The probe deliberately does not register with the cluster coordination
 * layer or produce a TaskRecord — it is a side-effect-free sanity check,
 * not a real task dispatch.
 */

import { logger } from '@/utils/logger';
import type { ClusterConfig, WorkerBackendType, WorkerTemplateConfig } from './config';
import type { WorkerBackend } from './types';
import { checkWorkerTemplateHealth } from './WorkerTemplateHealthCheck';

export interface WorkerProbeResult {
  templateName: string;
  type: WorkerBackendType;
  ok: boolean;
  durationMs: number;
  reason?: string;
  /** Origin of the credential the CLI would use — never the credential itself. */
  credentialSource?: string;
  endpoint?: string;
  model?: string;
  warnings?: string[];
}

/** The environment a worker of this template would be spawned with. */
function resolveTemplateEnv(template: WorkerTemplateConfig): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') merged[key] = value;
  }
  return { ...merged, ...(template.env || {}) };
}

async function verifyOneTemplate(
  templateName: string,
  template: WorkerTemplateConfig,
  backend: WorkerBackend,
  timeoutMs: number,
): Promise<WorkerProbeResult> {
  const start = Date.now();
  try {
    const result = await backend.verifyCredentials({
      env: resolveTemplateEnv(template),
      args: template.args,
      timeoutMs,
    });
    return { templateName, type: template.type, durationMs: Date.now() - start, ...result };
  } catch (err) {
    return {
      templateName,
      type: template.type,
      ok: false,
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check the credential of every enabled worker template (or the subset named
 * in `opts.templates`). Runs `checkWorkerTemplateHealth` once up front so a
 * template with a missing binary or a placeholder key is reported without a
 * pointless network round trip.
 */
export async function probeWorkerTemplates(
  config: ClusterConfig,
  getBackend: (type: WorkerBackendType) => WorkerBackend | undefined,
  opts?: { templates?: string[]; timeoutMs?: number },
): Promise<WorkerProbeResult[]> {
  const timeoutMs = opts?.timeoutMs ?? config.healthCheck.probeTimeout;
  const requestedNames = opts?.templates ?? Object.keys(config.workerTemplates);

  const results: WorkerProbeResult[] = [];
  const enabledNames: string[] = [];

  for (const name of requestedNames) {
    const template = config.workerTemplates[name];
    if (!template) {
      results.push({ templateName: name, type: 'claude-cli', ok: false, durationMs: 0, reason: 'unknown template' });
      continue;
    }
    if (template.enabled === false) continue;
    enabledNames.push(name);
  }

  if (enabledNames.length === 0) return results;

  const staticResults = await checkWorkerTemplateHealth(config);
  const staticByName = new Map(staticResults.map((r) => [r.templateName, r]));

  const runnable: string[] = [];
  for (const name of enabledNames) {
    const staticResult = staticByName.get(name);
    if (staticResult && !staticResult.available) {
      results.push({
        templateName: name,
        type: config.workerTemplates[name].type,
        ok: false,
        durationMs: 0,
        reason: staticResult.warnings.join('; '),
      });
      continue;
    }
    runnable.push(name);
  }

  const probed = await Promise.all(
    runnable.map(async (name) => {
      const template = config.workerTemplates[name];
      const backend = getBackend(template.type);
      if (!backend) {
        return {
          templateName: name,
          type: template.type,
          ok: false,
          durationMs: 0,
          reason: `no backend registered for type ${template.type}`,
        };
      }
      return verifyOneTemplate(name, template, backend, timeoutMs);
    }),
  );

  results.push(...probed);

  const warningLines = results.flatMap((r) => (r.warnings ?? []).map((w) => `  ! ${r.templateName}: ${w}`));
  if (warningLines.length > 0) {
    logger.warn(`[WorkerProbe] credential warnings:\n${warningLines.join('\n')}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    logger.warn(
      `[WorkerProbe] ${failed.length}/${results.length} template(s) failed credential check:\n` +
        failed.map((r) => `  ✗ ${r.templateName}: ${r.reason}`).join('\n'),
    );
  }

  return results;
}
