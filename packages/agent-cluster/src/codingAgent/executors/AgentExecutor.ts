import type { AgentExecutorName, AgentTask } from '../types';

export interface AgentInvocationInput {
  task: AgentTask;
  /** The rendered task prompt — identical whichever executor runs it. */
  prompt: string;
  workingDirectory: string;
  /** Bot MCP endpoint; the executor must send `X-Task-Id: <task.id>` on every request to it. */
  mcpUrl: string;
}

export interface AgentInvocation {
  cmd: string[];
  env: Record<string, string | undefined>;
  /** Written to the process's stdin when set; otherwise stdin is closed. */
  stdin?: string;
  /** Removes whatever the invocation created on disk. Runs after the process exits. */
  cleanup(): Promise<void>;
}

/** A model the executor can run, with the reasoning efforts it accepts. */
export interface ExecutorModel {
  id: string;
  efforts: readonly string[];
}

/**
 * One coding-agent CLI. Everything about a task except how its CLI is launched
 * — queueing, prompt, MCP callbacks, result delivery — is shared across
 * executors, so an executor only translates a task into a process invocation.
 *
 * The CLI must keep writing to stdout or stderr while it works (the idle
 * watchdog treats a silent process as stalled), and `finalMessage` must be
 * able to recover the agent's final answer from everything it wrote to stdout.
 */
export interface AgentExecutor {
  readonly name: AgentExecutorName;
  /** Shown to the requester in chat. */
  readonly displayName: string;
  /** Commit trailer the task prompt asks the agent to add. */
  readonly coAuthorTrailer: string;
  readonly defaultModel: string;
  /** Unset means the CLI's own default effort. */
  readonly defaultEffort?: string;
  /** Models a task may select with `--model`, each with the efforts `--effort` may select. */
  listModels(): Promise<ExecutorModel[]>;
  buildInvocation(input: AgentInvocationInput): Promise<AgentInvocation>;
  finalMessage(stdout: string): string;
}
