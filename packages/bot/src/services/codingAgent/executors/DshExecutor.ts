import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DshExecutorConfig } from '@/core/config';
import { parseDshJsonStream } from '@/utils/dshJsonStream';
import type { AgentExecutor, AgentInvocation, AgentInvocationInput, ExecutorModel } from './AgentExecutor';

/** Pinned for the same reason as the other executors: without it the run follows the CLI's own stored default. */
const DEFAULT_DSH_MODEL = 'deepseek-flash';

/** Rides the DeepSeek Harness Desktop login under `$DSH_HOME`, so no API key is needed in the bot's environment. */
const DEFAULT_DSH_PROVIDER = 'deepseek-account';

/** DSH's own advisory model catalog for the DeepSeek route — deployments may replace it. */
const DEEPSEEK_MODEL_IDS = ['deepseek-flash', 'deepseek-v4-pro'];

/** `dsh-llm-deepseek`: the reasoning efforts the DeepSeek route accepts. */
const DSH_EFFORT_LEVELS = ['off', 'low', 'high', 'max'];

/**
 * `dsh headless` answers one task and exits: the answer goes to stdout, diagnostics
 * to stderr. `--json` replaces the plain answer with newline-delimited run events,
 * which keeps stdout writing while the agent works (the idle watchdog treats a
 * silent process as stalled) and still carries the final answer losslessly.
 *
 * The task is fed on stdin (`-`) so templated prompts never hit argv limits, and the
 * per-task settings ride a `--patch` overlay — the DSH equivalent of claude's
 * `--mcp-config` file and codex's `-c` argv overrides.
 */
export class DshExecutor implements AgentExecutor {
  readonly name = 'dsh';
  readonly displayName = 'DeepSeek Harness';
  readonly coAuthorTrailer = 'Co-Authored-By: DeepSeek Harness <noreply@deepseek.com>';
  readonly defaultModel: string;
  readonly defaultEffort?: string;

  private readonly provider: string;

  constructor(private readonly config: DshExecutorConfig) {
    this.defaultModel = config.model || DEFAULT_DSH_MODEL;
    this.defaultEffort = config.effort;
    this.provider = config.provider || DEFAULT_DSH_PROVIDER;
  }

  /** The CLI has no model catalog to query, so the set is its documented route catalog plus what the config names. */
  async listModels(): Promise<ExecutorModel[]> {
    const ids = [...new Set([this.defaultModel, ...(this.config.models ?? []), ...DEEPSEEK_MODEL_IDS])].sort();
    return ids.map((id) => ({ id, efforts: DSH_EFFORT_LEVELS }));
  }

  async buildInvocation({ task, prompt, mcpUrl }: AgentInvocationInput): Promise<AgentInvocation> {
    const overlayPath = join(tmpdir(), `coding-agent-dsh-${task.id}.json`);
    await writeFile(
      overlayPath,
      JSON.stringify(
        [
          {
            id: 'agent-default-model',
            config: {
              provider: this.provider,
              model: task.model,
              ...(task.effort ? { reasoningEffort: task.effort } : {}),
            },
          },
          {
            insert: [
              {
                id: 'mcp-qqbot',
                name: '@deepseek-ai/dsh-mcp-client',
                config: {
                  serverName: 'qqbot',
                  transport: 'streamable-http',
                  url: mcpUrl,
                  headers: { 'X-Task-Id': task.id },
                },
              },
            ],
          },
        ],
        null,
        2,
      ),
    );

    return {
      cmd: [this.config.cliPath || 'dsh', 'headless', '--patch', overlayPath, '--json', '-'],
      // The run is unattended, so the approval prompt has nobody to answer it: task
      // creation already implies the operator authorized whatever the agent does.
      // Same stance as claude's --dangerously-skip-permissions and codex's bypass.
      env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access' },
      stdin: prompt,
      cleanup: () => rm(overlayPath, { force: true }),
    };
  }

  finalMessage(stdout: string): string {
    return parseDshJsonStream(stdout).finalMessage;
  }
}
