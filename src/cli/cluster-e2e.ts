// Cluster end-to-end test — boots the full bootstrap path, starts the
// Agent Cluster, submits one minimal task, and asserts that it actually
// flows through scheduler → worker → backend → DB writeback.
//
// Two modes:
//
//   1. Sentinel mode (default) — Phase 1 pipeline check. Prompts the agent
//      to echo a literal string and asserts it appears in task.output.
//      Validates: spawn → stdout capture → parseOutput → markTaskCompleted
//      → persistTask → poll readback.
//
//   2. MCP mode (--mcp-tool hub_claim | hub_report | hub_ask) — Phase 2
//      wiring check. Prompts the agent to call a hub_xxx MCP tool with a
//      unique sentinel argument, then asserts the hub-side EventLog (or
//      escalation callback) recorded the call. Validates the complete
//      worker→hub loop: claude MCP client → /mcp → HubMCPServer →
//      ContextHub.handleXxx → EventLog/PlannerService → SQLite.
//       - hub_claim: asserts a `lock_acquired` event with our UUID file path
//         in its `files` array. Validates LockManager path.
//       - hub_report: asserts a `task_completed` event with our UUID summary
//         string. Additionally validates the Phase 2 round 2 reportCallback
//         wiring (ContextHub → ClusterScheduler.markTaskCompleted without
//         waiting for process exit).
//       - hub_ask: asserts the EscalationCallback (installed in-test,
//         overriding the bootstrap QQ-owner notifier) was fired with our
//         UUID question. Validates the Phase 2 round 2 §2.5 PlannerService
//         escalation path: ContextHub.handleAsk → cluster_help_requests →
//         PlannerService.processHelpRequests poll → notifyEscalation.
//
// Usage:
//   bun run cluster:e2e [--project <alias>] [--template <name>] \
//                       [--task "<prompt>"] [--timeout-sec 300] \
//                       [--hub-port 3201] [--sentinel STR] \
//                       [--mcp-tool hub_claim|hub_report|hub_ask]
//
// Examples:
//   bun run cluster:e2e                                # sentinel mode, default template
//   bun run cluster:e2e --template gemini-pro          # sentinel mode, force gemini-pro
//   bun run cluster:e2e --mcp-tool hub_claim           # hub_claim wiring
//   bun run cluster:e2e --mcp-tool hub_report          # hub_report + reportCallback wiring
//   bun run cluster:e2e --mcp-tool hub_ask             # hub_ask + escalation callback wiring
//   bun run cluster:e2e --template minimax-m2 --timeout-sec 240
//
// The --template flag overrides `projects[<project>].workerPreference` for
// this run only — useful when you want to e2e-test a specific provider
// without editing cluster.jsonc.
//
// Exit codes:
//   0 — task completed and the mode-specific assertion passed
//   1 — task failed, timed out, or assertion failed
//
// Requires:
//   - cluster.enabled === true in config
//   - The chosen template's CLI binary is on PATH and authed
//     (e.g. `claude` for claude-sonnet/minimax-m2, `gemini` for gemini-pro,
//     `codex` for codex-gpt5)
//   - For provider-specific templates, the matching API key in template.env
//     (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, etc.)

import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { ClusterManager } from '@/cluster/ClusterManager';
import type { EventEntry, TaskRecord } from '@/cluster/types';
import { bootstrapApp } from '@/core/bootstrap';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { stopStaticFileServer } from '@/services/staticServer';
import { logger } from '@/utils/logger';

/** Supported values for --mcp-tool. Empty string = sentinel mode. */
type McpTool = '' | 'hub_claim' | 'hub_report' | 'hub_ask';

interface E2EArgs {
  project: string;
  /** Optional override for the project's workerPreference template name. */
  template: string | null;
  task: string;
  timeoutSec: number;
  sentinel: string;
  hubPort: number;
  /** Empty = Phase 1 sentinel mode; non-empty = Phase 2 MCP wiring mode. */
  mcpTool: McpTool;
  /**
   * hub_claim mode only: a unique file path the agent must pass to hub_claim.
   * We generate it per-run so the post-task EventLog scan can match this
   * exact value, ruling out any stale `lock_acquired` events from prior runs.
   */
  mcpClaimFile: string;
  /**
   * hub_report mode only: a unique summary string the agent must pass to
   * hub_report. Per-run so the assert can't accidentally match a stale
   * `task_completed` event from a previous run.
   */
  mcpReportSummary: string;
  /**
   * hub_ask mode only: a unique question string the agent must pass to
   * hub_ask. Per-run so the EscalationCallback assert can't false-positive
   * on a prior run's pending request.
   */
  mcpAskQuestion: string;
}

function parseArgs(): E2EArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
    return fallback;
  };
  const sentinel = get('--sentinel', 'CLUSTER_E2E_OK_42');
  const templateRaw = get('--template', '');

  const mcpToolRaw = get('--mcp-tool', '');
  if (mcpToolRaw && mcpToolRaw !== 'hub_claim' && mcpToolRaw !== 'hub_report' && mcpToolRaw !== 'hub_ask') {
    throw new Error(`Unsupported --mcp-tool "${mcpToolRaw}". Supported: hub_claim, hub_report, hub_ask`);
  }
  const mcpTool = mcpToolRaw as McpTool;

  // Per-run unique path so the EventLog assertion below can't accidentally
  // match a `lock_acquired` event from a previous run. The file doesn't
  // need to exist on disk — LockManager only stores the path string.
  const mcpClaimFile = get('--mcp-claim-file', `/tmp/cluster-e2e-${randomUUID()}.txt`);

  // Per-run unique summary for hub_report mode. Same rationale: prevents a
  // prior run's `task_completed` event from producing a false positive.
  const mcpReportSummary = get('--mcp-report-summary', `cluster-e2e hub_report wiring test ${randomUUID()}`);

  // Per-run unique question for hub_ask mode. The EscalationCallback assert
  // looks for this exact string in the HelpRequest payload it receives.
  const mcpAskQuestion = get('--mcp-ask-question', `cluster-e2e hub_ask escalation wiring test ${randomUUID()}`);

  // Default task is sentinel-mode. In MCP mode, we build a more specific
  // prompt that asks the agent to call the hub tool.
  const defaultSentinelTask = `This is an end-to-end test of the cluster pipeline. Please reply with EXACTLY the literal string ${sentinel} on a single line, with no additional commentary.`;

  const defaultMcpClaimTask =
    `This is an end-to-end test of the cluster's MCP wiring. You have an MCP ` +
    `server registered as "cluster-context-hub" which exposes a tool called ` +
    `"hub_claim". Call that tool EXACTLY ONCE with these arguments:\n` +
    `  taskId: "${sentinel}"\n` +
    `  intent: "cluster-e2e MCP wiring test"\n` +
    `  files: ["${mcpClaimFile}"]\n` +
    `After the tool returns, reply with EXACTLY the literal string ${sentinel} ` +
    `on a single line and nothing else. Do not call any other tools. Do not ` +
    `edit or create files on disk.`;

  // hub_report mode: ask the agent to declare itself done via hub_report,
  // passing the per-run summary string. The hub-side reportCallback will
  // fire and flush scheduler state; the assert below scans cluster_events
  // for a `task_completed` event whose summary matches.
  const defaultMcpReportTask =
    `This is an end-to-end test of the cluster's MCP wiring. You have an MCP ` +
    `server registered as "cluster-context-hub" which exposes a tool called ` +
    `"hub_report". Call that tool EXACTLY ONCE with these arguments:\n` +
    `  status: "completed"\n` +
    `  summary: "${mcpReportSummary}"\n` +
    `After the tool returns, reply with EXACTLY the literal string ${sentinel} ` +
    `on a single line and nothing else. Do not call any other tools. Do not ` +
    `edit or create files on disk.`;

  // hub_ask mode: ask the agent to escalate via hub_ask. We force
  // type=escalation so PlannerService routes through the human-notification
  // path (notifyEscalation → escalationCallback) instead of trying to find
  // a planner worker. The assert below installs a synchronous in-test
  // EscalationCallback that records the HelpRequest, then verifies the
  // recorded request's `question` matches our per-run UUID.
  const defaultMcpAskTask =
    `This is an end-to-end test of the cluster's MCP wiring. You have an MCP ` +
    `server registered as "cluster-context-hub" which exposes a tool called ` +
    `"hub_ask". Call that tool EXACTLY ONCE with these arguments:\n` +
    `  type: "escalation"\n` +
    `  question: "${mcpAskQuestion}"\n` +
    `After the tool returns (it returns immediately with an askId — you do ` +
    `NOT need to wait for a real answer), reply with EXACTLY the literal ` +
    `string ${sentinel} on a single line and nothing else. Do not call any ` +
    `other tools. Do not edit or create files on disk.`;

  let defaultTask: string;
  if (mcpTool === 'hub_claim') {
    defaultTask = defaultMcpClaimTask;
  } else if (mcpTool === 'hub_report') {
    defaultTask = defaultMcpReportTask;
  } else if (mcpTool === 'hub_ask') {
    defaultTask = defaultMcpAskTask;
  } else {
    defaultTask = defaultSentinelTask;
  }

  return {
    project: get('--project', process.env.CLUSTER_E2E_PROJECT || 'qqbot'),
    template: templateRaw || null,
    task: get('--task', defaultTask),
    timeoutSec: Number(get('--timeout-sec', '300')),
    sentinel,
    // Default to 3201 (one above the conventional 3200) so the e2e can run
    // alongside a live `bun run dev` cluster without port collision.
    hubPort: Number(get('--hub-port', '3201')),
    mcpTool,
    mcpClaimFile,
    mcpReportSummary,
    mcpAskQuestion,
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
  // `config.hub.port` lazily inside `start()`, and ClusterScheduler reads
  // `config.projects[*].workerPreference` inside its dispatch helper, so
  // mutating the parsed ClusterConfig object after construction is safe.
  const clusterConfig = (
    cluster as unknown as {
      config: {
        hub: { port: number };
        projects: Record<string, { workerPreference: string }>;
        workerTemplates: Record<string, unknown>;
      };
    }
  ).config;

  if (clusterConfig?.hub) {
    logger.info(`[ClusterE2E] Overriding hub port: ${clusterConfig.hub.port} → ${args.hubPort}`);
    clusterConfig.hub.port = args.hubPort;
  }

  // Optional --template override: rewrite the project's workerPreference
  // for this run only. Validate that the requested template actually
  // exists in workerTemplates so a typo gets caught up front instead of
  // failing inside spawnWorker.
  if (args.template) {
    if (!clusterConfig?.workerTemplates || !(args.template in clusterConfig.workerTemplates)) {
      logger.error(
        `[ClusterE2E] ✗ Unknown worker template "${args.template}". Available: ${
          clusterConfig?.workerTemplates ? Object.keys(clusterConfig.workerTemplates).join(', ') : '(none)'
        }`,
      );
      await teardown(conversationComponents);
      process.exit(1);
    }
    const projectEntry = clusterConfig.projects?.[args.project];
    if (!projectEntry) {
      logger.error(
        `[ClusterE2E] ✗ Project "${args.project}" not found in cluster.projects. Cannot override workerPreference.`,
      );
      await teardown(conversationComponents);
      process.exit(1);
    }
    logger.info(
      `[ClusterE2E] Overriding workerPreference for project "${args.project}": ${projectEntry.workerPreference} → ${args.template}`,
    );
    projectEntry.workerPreference = args.template;
  }

  // hub_ask mode: install an in-test EscalationCallback that records the
  // HelpRequest synchronously so the assert below can verify the agent
  // really called hub_ask with our per-run UUID question. This OVERRIDES
  // the QQ-owner notifier wired by bootstrap — that's intentional, the
  // e2e doesn't want to actually push a QQ message every run.
  //
  // PlannerService.setEscalationCallback is last-write-wins, so just
  // calling attachEscalationNotifier here replaces the bootstrap one.
  // We deliberately do NOT restore the bootstrap notifier on teardown:
  // the e2e process exits right after, so the bootstrap notifier never
  // gets a chance to run anyway.
  let recordedEscalation: import('@/cluster/types').HelpRequest | null = null;
  if (args.mcpTool === 'hub_ask') {
    cluster.attachEscalationNotifier((request) => {
      logger.info(
        `[ClusterE2E] EscalationCallback received: askId=${request.id} type=${request.type} question="${request.question.slice(0, 80)}"`,
      );
      recordedEscalation = request;
    });
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

    // In hub_report mode the reportCallback fast-path can mark the task
    // terminal **before** the worker process has flushed its final stdout
    // (the agent typically calls hub_report, then prints the sentinel
    // afterwards). If we proceed straight to cluster.stop() now, SIGTERM
    // would kill the worker mid-flush, parseOutput would see truncated
    // output, and the sentinel assertion would falsely fail.
    //
    // Wait for `task.output` to become non-empty (capped at 30s) so the
    // exit-code path has a chance to populate it. For sentinel/hub_claim
    // modes the output is set by the same code path that flips status, so
    // this is a no-op (output is already populated when status is terminal).
    if (args.mcpTool === 'hub_report' && !task.output) {
      const graceMs = 30_000;
      const start = Date.now();
      while (Date.now() - start < graceMs && !task.output) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!task.output) {
        logger.warn(
          `[ClusterE2E] hub_report mode: waited ${graceMs}ms after terminal status but task.output ` +
            `is still empty. Worker may have crashed or never printed anything after hub_report.`,
        );
      }
    }

    // hub_ask mode: PlannerService.processHelpRequests polls every 10s,
    // so the escalation callback may not have fired yet by the time the
    // worker process exits. Wait up to 15s for `recordedEscalation` to be
    // populated. The callback is what we're asserting on; this can't be
    // skipped — the polling interval is the inherent latency.
    if (args.mcpTool === 'hub_ask' && !recordedEscalation) {
      const graceMs = 15_000;
      const start = Date.now();
      while (Date.now() - start < graceMs && !recordedEscalation) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!recordedEscalation) {
        logger.warn(
          `[ClusterE2E] hub_ask mode: waited ${graceMs}ms for PlannerService to fire escalation ` +
            `callback but it never did. Either the agent didn't call hub_ask, hub_ask wasn't ` +
            `routed through notifyEscalation, or the escalation callback is missing.`,
        );
      }
    }

    logger.info(`[ClusterE2E] Task ${task.id} terminal status: ${task.status}`);
    if (task.output) {
      const preview = task.output.length > 500 ? `${task.output.slice(0, 500)}…` : task.output;
      logger.info(`[ClusterE2E] Task output preview:\n${preview}`);
    }
    if (task.error) {
      logger.error(`[ClusterE2E] Task error: ${task.error}`);
    }

    const sentinelInOutput = (task.output ?? '').includes(args.sentinel);

    // Mode-specific assertion.
    //
    // Sentinel mode: task.output must contain the sentinel string. That's it.
    //
    // hub_claim mode: in addition to the sentinel echo, the hub-side EventLog
    // must contain a `lock_acquired` event whose `files` includes the unique
    // path we handed to the agent. Scanning the EventLog proves the full loop
    // ran:
    //   claude → stdio MCP client → /mcp route in ContextHub → HubMCPServer
    //   → extractWorkerId(X-Worker-Id) → runTool('hub_claim', ...) →
    //   ContextHub.handleClaim → LockManager.tryAcquire → eventLog.append.
    //
    // hub_report mode: scans for a `task_completed` event whose `summary` is
    // the per-run UUID we handed the agent. This additionally validates the
    // Phase 2 round 2 reportCallback: the scheduler must see the task marked
    // completed via the hub_report path (the assert below on task.status
    // would also be satisfied by the exit-code path, so the summary-scan is
    // the part that actually differentiates the two).
    //
    // We query AFTER cluster.stop() is called further down to keep the hub
    // DB handle alive while we read — hub and hub DB share the app's
    // SQLiteAdapter so reads are cheap and don't race the worker.
    let mcpEventMatched = false;
    let mcpEvents: EventEntry[] = [];
    if (args.mcpTool === 'hub_claim') {
      // Limit high enough to span all events from this short run. EventLog
      // stores most recent first, so the relevant ones are always at the top.
      mcpEvents = cluster.getHub().eventLog.query({ type: 'lock_acquired', limit: 200 });
      mcpEventMatched = mcpEvents.some((e) => {
        const data = e.data as { files?: unknown; intent?: unknown } | undefined;
        const files = Array.isArray(data?.files) ? (data.files as unknown[]) : [];
        return files.some((f) => f === args.mcpClaimFile);
      });
      logger.info(
        `[ClusterE2E] MCP mode assertion: scanned ${mcpEvents.length} lock_acquired event(s); ` +
          `matched our claim file? ${mcpEventMatched}`,
      );
    } else if (args.mcpTool === 'hub_report') {
      mcpEvents = cluster.getHub().eventLog.query({ type: 'task_completed', limit: 200 });
      mcpEventMatched = mcpEvents.some((e) => {
        const data = e.data as { summary?: unknown } | undefined;
        return typeof data?.summary === 'string' && data.summary === args.mcpReportSummary;
      });
      logger.info(
        `[ClusterE2E] MCP mode assertion: scanned ${mcpEvents.length} task_completed event(s); ` +
          `matched our report summary? ${mcpEventMatched}`,
      );
    } else if (args.mcpTool === 'hub_ask') {
      // hub_ask doesn't use the EventLog scan path. The recorded
      // escalation callback's HelpRequest.question is the canonical
      // assert source. We narrow the type because TS doesn't know the
      // closure mutated `recordedEscalation` from null.
      const captured = recordedEscalation as import('@/cluster/types').HelpRequest | null;
      mcpEventMatched = captured !== null && captured.question === args.mcpAskQuestion;
      logger.info(
        `[ClusterE2E] MCP mode assertion: escalation callback fired? ${captured !== null}; ` +
          `question matched? ${mcpEventMatched}`,
      );
    }

    const sentinelPass = sentinelInOutput;
    const mcpPass =
      args.mcpTool === 'hub_claim' || args.mcpTool === 'hub_report' || args.mcpTool === 'hub_ask'
        ? mcpEventMatched
        : true;
    const success = task.status === 'completed' && sentinelPass && mcpPass;

    await cluster.stop();
    await teardown(conversationComponents);

    if (success) {
      if (args.mcpTool === 'hub_claim') {
        logger.info(
          `[ClusterE2E] ✅ PASS (MCP mode) — task completed, sentinel echoed, and hub recorded ` +
            `lock_acquired event for ${args.mcpClaimFile}`,
        );
      } else if (args.mcpTool === 'hub_report') {
        logger.info(
          `[ClusterE2E] ✅ PASS (MCP mode) — task completed, sentinel echoed, and hub recorded ` +
            `task_completed event with summary "${args.mcpReportSummary}"`,
        );
      } else if (args.mcpTool === 'hub_ask') {
        logger.info(
          `[ClusterE2E] ✅ PASS (MCP mode) — task completed, sentinel echoed, and PlannerService ` +
            `fired the escalation callback with question matching "${args.mcpAskQuestion}"`,
        );
      } else {
        logger.info(`[ClusterE2E] ✅ PASS — task completed and output contained sentinel "${args.sentinel}"`);
      }
      process.exit(0);
    }

    if (task.status === 'completed' && !sentinelPass) {
      logger.error(
        `[ClusterE2E] ✗ FAIL — task completed but sentinel "${args.sentinel}" not found in output. ` +
          `The cluster pipeline works, but the agent didn't follow instructions; check the output above.`,
      );
      process.exit(1);
    }
    if (task.status === 'completed' && !mcpPass) {
      if (args.mcpTool === 'hub_claim') {
        logger.error(
          `[ClusterE2E] ✗ FAIL (MCP mode) — task completed and sentinel echoed, but hub saw no ` +
            `lock_acquired event for "${args.mcpClaimFile}". This means the agent printed the sentinel ` +
            `WITHOUT actually calling hub_claim — either the MCP client didn't connect to /mcp at all, ` +
            `or claude silently skipped the tool call. Check [HubMCPServer] logs above and verify the ` +
            `worker MCP config file on disk.`,
        );
      } else if (args.mcpTool === 'hub_report') {
        logger.error(
          `[ClusterE2E] ✗ FAIL (MCP mode) — task completed and sentinel echoed, but hub saw no ` +
            `task_completed event with summary "${args.mcpReportSummary}". The agent printed the ` +
            `sentinel WITHOUT actually calling hub_report, or called it with a different summary. ` +
            `Check [HubMCPServer] logs above and verify hub_report was invoked.`,
        );
      } else {
        // hub_ask
        logger.error(
          `[ClusterE2E] ✗ FAIL (MCP mode) — task completed and sentinel echoed, but PlannerService ` +
            `never fired the escalation callback with question "${args.mcpAskQuestion}". Either the ` +
            `agent didn't call hub_ask, called it with the wrong question, or PlannerService.processHelpRequests ` +
            `polling didn't catch up within the grace period.`,
        );
      }
      process.exit(1);
    }
    logger.error(`[ClusterE2E] ✗ FAIL — task ended in status="${task.status}"`);
    process.exit(1);
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
