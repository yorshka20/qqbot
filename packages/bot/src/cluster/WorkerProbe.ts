/**
 * WorkerProbe — live liveness check for worker templates.
 *
 * WorkerTemplateHealthCheck only validates static preconditions (binary on
 * PATH, required env vars present) — it never actually runs a worker, so
 * expired CLI logins, wrong base URLs, and provider outages stay invisible
 * until a real ticket dispatches and fails. probeWorkerTemplates spawns
 * each enabled template through the same `WorkerBackend.spawn()` path a
 * real task uses, with a trivial prompt, and checks the reply for a fixed
 * token — the only way to confirm the CLI can actually reach its provider
 * and answer.
 *
 * The probe deliberately does not register with the cluster coordination
 * layer or produce a TaskRecord — it is a side-effect-free sanity check,
 * not a real task dispatch.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  output?: string;
}

const PROBE_TOKEN = 'CLUSTER_PROBE_OK';
const PROBE_PROMPT = `Reply with exactly this token and nothing else: ${PROBE_TOKEN}`;

/** How many probes run concurrently. Keeps a large fleet of templates from
 *  all spawning CLIs at once and thrashing the machine. */
const PROBE_CONCURRENCY = 4;

async function runBatched<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function probeOneTemplate(
  templateName: string,
  template: WorkerTemplateConfig,
  backend: WorkerBackend,
  timeoutMs: number,
): Promise<WorkerProbeResult> {
  const start = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'cluster-probe-'));
  try {
    const mcpConfigPath = join(dir, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

    const proc = await backend.spawn({
      workerId: `probe-${templateName}-${randomUUID().slice(0, 6)}`,
      taskPrompt: PROBE_PROMPT,
      projectPath: dir,
      mcpConfigPath,
      hubUrl: '',
      command: template.command,
      args: template.args,
      env: { ...(template.env || {}) },
      timeout: timeoutMs,
    });

    const exited = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);

    if (exited === 'timeout') {
      proc.kill();
      return {
        templateName,
        type: template.type,
        ok: false,
        durationMs: Date.now() - start,
        reason: `timeout after ${timeoutMs}ms`,
      };
    }

    const exitCode = exited;
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const finalMessage = backend.parseOutput ? backend.parseOutput(stdout).finalMessage : stdout;
    const ok = exitCode === 0 && finalMessage.includes(PROBE_TOKEN);

    return {
      templateName,
      type: template.type,
      ok,
      durationMs: Date.now() - start,
      reason: ok
        ? undefined
        : stderr.trim()
          ? stderr.trim().slice(0, 300)
          : `exit ${exitCode}, unexpected output: ${finalMessage.slice(0, 200)}`,
      output: finalMessage.slice(0, 200),
    };
  } catch (err) {
    return {
      templateName,
      type: template.type,
      ok: false,
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Probe every enabled worker template (or the subset named in
 * `opts.templates`) by spawning it with a trivial prompt and checking for
 * the expected reply. Runs `checkWorkerTemplateHealth` once up front so a
 * template with a missing binary or a placeholder key short-circuits
 * without burning a paid API call.
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

  const probed = await runBatched(runnable, PROBE_CONCURRENCY, async (name) => {
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
    try {
      return await probeOneTemplate(name, template, backend, timeoutMs);
    } catch (err) {
      return {
        templateName: name,
        type: template.type,
        ok: false,
        durationMs: 0,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  results.push(...probed);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    logger.warn(
      `[WorkerProbe] ${failed.length}/${results.length} template(s) failed live probe:\n` +
        failed.map((r) => `  ✗ ${r.templateName}: ${r.reason}`).join('\n'),
    );
  }

  return results;
}
