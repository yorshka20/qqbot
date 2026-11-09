// SubAgent Orchestrator — the sub-agent module's entry point for everything outside it.
//
// SubAgentManager (session registry) and SubAgentExecutor (runs a session) are the
// module's parts; callers only ever want "run this sub-agent and give me its output".

import { inject, singleton } from 'tsyringe';
import { SubAgentExecutor } from './SubAgentExecutor';
import { SubAgentManager } from './SubAgentManager';
import type { SubAgentConfig, SubAgentRun, SubAgentTask, SubAgentType } from './types';

@singleton()
export class SubAgentOrchestrator {
  constructor(
    @inject(SubAgentManager) private readonly manager: SubAgentManager,
    @inject(SubAgentExecutor) private readonly executor: SubAgentExecutor,
  ) {}

  /** Spawn a sub-agent, run it to completion and return its output with the LLM that wrote it. */
  async run(
    type: SubAgentType,
    task: SubAgentTask,
    configOverrides?: Partial<SubAgentConfig>,
    parentId?: string,
  ): Promise<SubAgentRun> {
    const sessionId = await this.manager.spawn(parentId, type, task, configOverrides);
    const { servedBy } = await this.executor.execute(sessionId);
    return { output: await this.manager.wait(sessionId), servedBy };
  }
}
