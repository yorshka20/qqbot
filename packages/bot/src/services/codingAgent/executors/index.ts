import type { CodingAgentConfig } from '@/core/config';
import type { AgentExecutorName } from '../types';
import type { AgentExecutor } from './AgentExecutor';
import { ClaudeExecutor } from './ClaudeExecutor';
import { CodexExecutor } from './CodexExecutor';

export type { AgentExecutor, ExecutorModel } from './AgentExecutor';

export function createAgentExecutors(config: CodingAgentConfig): Record<AgentExecutorName, AgentExecutor> {
  return {
    claude: new ClaudeExecutor(config.executors?.claude ?? {}),
    codex: new CodexExecutor(config.executors?.codex ?? {}),
  };
}
