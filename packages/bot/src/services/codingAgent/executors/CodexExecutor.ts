import type { AgentExecutorConfig } from '@/core/config';
import { codexMcpServerArgs, listCodexModels, withoutCodexApiKeys } from '@/utils/codexCli';
import type { AgentExecutor, AgentInvocation, AgentInvocationInput, ExecutorModel } from './AgentExecutor';

/** Pinned for the same reason as the claude model: the CLI default follows the operator's interactive setting. */
const DEFAULT_CODEX_MODEL = 'gpt-6-sol';

/**
 * `codex exec` prints only the final agent message to stdout; the whole
 * transcript, including command output, goes to stderr, which also keeps the
 * idle watchdog fed. The prompt is fed on stdin (`-`) so templated prompts
 * never hit argv limits.
 */
export class CodexExecutor implements AgentExecutor {
  readonly name = 'codex';
  readonly displayName = 'Codex';
  readonly coAuthorTrailer = 'Co-Authored-By: Codex <noreply@openai.com>';
  readonly defaultModel: string;
  readonly defaultEffort?: string;

  constructor(private readonly config: AgentExecutorConfig) {
    this.defaultModel = config.model || DEFAULT_CODEX_MODEL;
    this.defaultEffort = config.effort;
  }

  listModels(): Promise<ExecutorModel[]> {
    return listCodexModels(this.config.cliPath || 'codex');
  }

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
        task.model,
        ...(task.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(task.effort)}`] : []),
        // `codex exec` has no web search unless enabled; claude's WebSearch is on by default.
        '-c',
        'web_search="live"',
        ...codexMcpServerArgs('qqbot', mcpUrl, { 'X-Task-Id': task.id }),
        '-',
      ],
      env: withoutCodexApiKeys(process.env),
      stdin: prompt,
      cleanup: async () => {},
    };
  }

  finalMessage(stdout: string): string {
    return stdout;
  }
}
