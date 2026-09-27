import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutorConfig } from '@/core/config';
import { parseClaudeStreamJson } from '@/utils/claudeStreamJson';
import type { AgentExecutor, AgentInvocation, AgentInvocationInput, ExecutorModel } from './AgentExecutor';

/**
 * Without `--model` the CLI falls back to whatever the local install last
 * used, so a bot task would silently run on a different model than the
 * operator expects.
 */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

/** `claude --help`: "--model … Provide an alias for the latest model (e.g. 'sonnet' or 'opus')". */
const CLAUDE_MODEL_ALIASES = ['haiku', 'opus', 'sonnet'];

/** `claude --help`: "--effort <level> … (low, medium, high, max)". */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

export class ClaudeExecutor implements AgentExecutor {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly coAuthorTrailer = 'Co-Authored-By: Claude <noreply@anthropic.com>';
  readonly defaultModel: string;
  readonly defaultEffort?: string;

  constructor(private readonly config: AgentExecutorConfig) {
    this.defaultModel = config.model || DEFAULT_CLAUDE_MODEL;
    this.defaultEffort = config.effort;
  }

  /** The CLI has no model catalog, so the set is its documented aliases plus what the config names. */
  async listModels(): Promise<ExecutorModel[]> {
    const ids = [...new Set([this.defaultModel, ...(this.config.models ?? []), ...CLAUDE_MODEL_ALIASES])].sort();
    return ids.map((id) => ({ id, efforts: CLAUDE_EFFORT_LEVELS }));
  }

  async buildInvocation({ task, prompt, mcpUrl }: AgentInvocationInput): Promise<AgentInvocation> {
    const mcpConfigPath = join(tmpdir(), `coding-agent-mcp-${task.id}.json`);
    await writeFile(
      mcpConfigPath,
      JSON.stringify(
        { mcpServers: { qqbot: { type: 'http', url: mcpUrl, headers: { 'X-Task-Id': task.id } } } },
        null,
        2,
      ),
    );

    // `--mcp-config=<path>` MUST use the single-arg `=` form: Claude CLI treats
    // `--mcp-config` as a multi-value option that greedily slurps following
    // positionals, so the two-arg form would swallow the prompt as a second
    // config path and fail with "MCP config file not found: <prompt>".
    //
    // `stream-json` rather than `text`: text mode writes nothing until the task
    // ends, which the idle watchdog cannot tell apart from a hung process.
    // `--print` requires `--verbose` for stream-json.
    return {
      cmd: [
        this.config.cliPath || 'claude',
        '--print',
        '--dangerously-skip-permissions',
        `--mcp-config=${mcpConfigPath}`,
        '--model',
        task.model,
        ...(task.effort ? ['--effort', task.effort] : []),
        '--output-format',
        'stream-json',
        '--verbose',
        prompt,
      ],
      env: { ...process.env },
      cleanup: () => rm(mcpConfigPath, { force: true }),
    };
  }

  finalMessage(stdout: string): string {
    return parseClaudeStreamJson(stdout).finalMessage;
  }
}
