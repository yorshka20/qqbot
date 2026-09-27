import type { AgentExecutorConfig } from '@/core/config';
import { codexMcpServerArgs, withoutCodexApiKeys } from '@/utils/codexCli';
import type { AgentExecutor, AgentInvocation, AgentInvocationInput } from './AgentExecutor';

/** Pinned for the same reason as the claude model: the CLI default follows the operator's interactive setting. */
const DEFAULT_CODEX_MODEL = 'gpt-6-sol';

/**
 * `codex exec` prints only the final agent message to stdout; the whole
 * transcript, including command output, goes to stderr. The prompt is fed on
 * stdin (`-`) so templated prompts never hit argv limits.
 */
export class CodexExecutor implements AgentExecutor {
  readonly name = 'codex';
  readonly displayName = 'Codex';
  readonly coAuthorTrailer = 'Co-Authored-By: Codex <noreply@openai.com>';

  constructor(private readonly config: AgentExecutorConfig) {}

  async buildInvocation({ task, prompt, workingDirectory, mcpUrl }: AgentInvocationInput): Promise<AgentInvocation> {
    return {
      cmd: [
        this.config.cliPath || 'codex',
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--cd',
        workingDirectory,
        '--model',
        this.config.model || DEFAULT_CODEX_MODEL,
        ...codexMcpServerArgs('qqbot', mcpUrl, { 'X-Task-Id': task.id }),
        '-',
      ],
      env: withoutCodexApiKeys(process.env),
      stdin: prompt,
      cleanup: async () => {},
    };
  }
}
