// Cluster end-to-end test — boots the full bootstrap path, starts the
// Agent Cluster, submits one minimal task, and asserts that it actually
// flows through scheduler → worker → backend → DB writeback.
//
// Usage:
//   bun run cluster:e2e [--project <alias>] [--task "<prompt>"] [--timeout-sec 300]
//   PROJECT=qqbot bun run cluster:e2e
//
// Exit codes:
//   0 — task completed successfully and output contained the sentinel
//   1 — task failed, timed out, or anything else went wrong
//
// Requires:
//   - cluster.enabled === true in config
//   - The configured workerPreference's CLI binary is on PATH and authed
//     (e.g. `claude` for the default `claude-sonnet` template, or
//     `codex`/`gemini` if you switched workerPreference)
//
// Why a sentinel string in the prompt?
//   The default Phase 1 success criterion is "task ran end-to-end and we
//   can read its output back from DB / WorkerPool". Asking the agent to
//   echo a fixed string lets the script assert that the entire pipeline
//   (spawn → stdout capture → parseOutput → markTaskCompleted →
//   persistTask → poll readback) is intact, without depending on any
//   specific LLM behavior beyond "follow a one-line instruction."

import 'reflect-metadata';

import type { ClusterManager } from '@/cluster/ClusterManager';
import type { TaskRecord } from '@/cluster/types';
import { bootstrapApp } from '@/core/bootstrap';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { stopStaticFileServer } from '@/services/staticServer';
import { logger } from '@/utils/logger';

interface E2EArgs {
  project: string;
  task: string;
  timeoutSec: number;
  sentinel: string;
  hubPort: number;
}

function parseArgs(): E2EArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
    return fallback;
  };
  const sentinel = get('--sentinel', 'CLUSTER_E2E_OK_42');
  return {
    project: get('--project', process.env.CLUSTER_E2E_PROJECT || 'qqbot'),
    task: get(
      '--task',
      `This is an end-to-end test of the cluster pipeline. Please reply with EXACTLY the literal string ${sentinel} on a single line, with no additional commentary.`,
    ),
    timeoutSec: Number(get('--timeout-sec', '300')),
    sentinel,
    // Default to 3201 (one above the conventional 3200) so the e2e can run
    // alongside a live `bun run dev` cluster without port collision.
    hubPort: Number(get('--hub-port', '3201')),
  };
}

/**
 * Watch a TaskRecord reference until it reaches a terminal status.
 *
 * The TaskRecord returned by `ClusterManager.submitTask()` is the same
 * object instance that flows through the scheduler → workerPool →
 * monitorProcess → markTaskCompleted pipeline, all of which mutate it
 * in place. So holding the reference and polling its `status` field is
 * sufficient — we don't need to query DB or scan workerPool internals.
 */
async function pollUntilTerminal(task: TaskRecord, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const intervalMs = 2_000;
  let lastLoggedStatus = task.status;
  while (Date.now() - start < timeoutMs) {
    if (task.status === 'completed' || task.status === 'failed') return true;
    if (task.status !== lastLoggedStatus) {
      logger.info(`[ClusterE2E] Task ${task.id} status: ${lastLoggedStatus} → ${task.status}`);
      lastLoggedStatus = task.status;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main() {
  const args = parseArgs();
  logger.info(`[ClusterE2E] Starting end-to-end test (project=${args.project}, timeout=${args.timeoutSec}s)`);

  const { conversationComponents } = await bootstrapApp(process.env.CONFIG_PATH, { skipPluginEnable: true });

  // Resolve ClusterManager from DI. If cluster wasn't enabled in config,
  // bootstrap would have skipped registration entirely.
  let cluster: ClusterManager;
  try {
    cluster = getContainer().resolve<ClusterManager>(DITokens.CLUSTER_MANAGER);
  } catch {
    logger.error('[ClusterE2E] ✗ ClusterManager not registered — is `cluster.enabled` true in config?');
    await teardown(conversationComponents);
    process.exit(1);
  }

  // Override the hub port BEFORE start() so we don't collide with a live
  // dev bot also holding the conventional cluster port. ContextHub reads
  // `config.hub.port` lazily inside `start()`, so mutating the parsed
  // ClusterConfig object after construction is safe.
  const clusterConfig = (cluster as unknown as { config: { hub: { port: number } } }).config;
  if (clusterConfig?.hub) {
    logger.info(`[ClusterE2E] Overriding hub port: ${clusterConfig.hub.port} → ${args.hubPort}`);
    clusterConfig.hub.port = args.hubPort;
  }

  try {
    await cluster.start();
    logger.info('[ClusterE2E] Cluster started; submitting task');

    const task = await cluster.submitTask(args.project, args.task);
    if (!task) {
      logger.error(
        `[ClusterE2E] ✗ submitTask returned null — project alias "${args.project}" probably not registered in ClaudeCodeService.projectRegistry`,
      );
      await cluster.stop();
      await teardown(conversationComponents);
      process.exit(1);
    }

    logger.info(`[ClusterE2E] Task submitted: id=${task.id} job=${task.jobId}; polling until terminal...`);

    // Note: ClusterScheduler's loop runs every config.schedulingInterval
    // (30s by default), so it may take that long for the worker to actually
    // spawn. Total timeout should account for: poll interval + worker spawn
    // + LLM round-trip + parseOutput.
    const reachedTerminal = await pollUntilTerminal(task, args.timeoutSec * 1_000);

    if (!reachedTerminal) {
      logger.error(`[ClusterE2E] ✗ Task ${task.id} did not reach a terminal state within ${args.timeoutSec}s`);
      await cluster.stop();
      await teardown(conversationComponents);
      process.exit(1);
    }

    logger.info(`[ClusterE2E] Task ${task.id} terminal status: ${task.status}`);
    if (task.output) {
      const preview = task.output.length > 500 ? `${task.output.slice(0, 500)}…` : task.output;
      logger.info(`[ClusterE2E] Task output preview:\n${preview}`);
    }
    if (task.error) {
      logger.error(`[ClusterE2E] Task error: ${task.error}`);
    }

    const success = task.status === 'completed' && (task.output ?? '').includes(args.sentinel);

    await cluster.stop();
    await teardown(conversationComponents);

    if (success) {
      logger.info(`[ClusterE2E] ✅ PASS — task completed and output contained sentinel "${args.sentinel}"`);
      process.exit(0);
    } else if (task.status === 'completed') {
      logger.error(
        `[ClusterE2E] ✗ FAIL — task completed but sentinel "${args.sentinel}" not found in output. ` +
          `The cluster pipeline works, but the agent didn't follow instructions; check the output above.`,
      );
      process.exit(1);
    } else {
      logger.error(`[ClusterE2E] ✗ FAIL — task ended in status="${task.status}"`);
      process.exit(1);
    }
  } catch (err) {
    logger.error('[ClusterE2E] ✗ Unhandled error during e2e:', err);
    try {
      await cluster.stop();
    } catch {
      // best effort
    }
    await teardown(conversationComponents);
    process.exit(1);
  }
}

async function teardown(components: Awaited<ReturnType<typeof bootstrapApp>>['conversationComponents']): Promise<void> {
  try {
    stopStaticFileServer();
  } catch {
    // best effort
  }
  try {
    await components.databaseManager.close();
  } catch {
    // best effort
  }
}

main().catch((err) => {
  logger.error('[ClusterE2E] ✗ Top-level error:', err);
  process.exit(1);
});
