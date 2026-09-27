import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutorConfig } from '@/core/config';
import type { AgentExecutor, AgentInvocation, AgentInvocationInput } from './AgentExecutor';

/**
 * Without `--model` the CLI falls back to whatever the local install last
 * used, so a bot task would silently run on a different model than the
 * operator expects.
 */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

export class ClaudeExecutor implements AgentExecutor {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly coAuthorTrailer = 'Co-Authored-By: Claude <noreply@anthropic.com>';

  constructor(private readonly config: AgentExecutorConfig) {}

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
    return {
      cmd: [
        this.config.cliPath || 'claude',
        '--print',
        '--dangerously-skip-permissions',
        `--mcp-config=${mcpConfigPath}`,
        '--model',
        this.config.model || DEFAULT_CLAUDE_MODEL,
        '--output-format',
        'text',
        prompt,
      ],
      env: { ...process.env },
      cleanup: () => rm(mcpConfigPath, { force: true }),
    };
  }
}
