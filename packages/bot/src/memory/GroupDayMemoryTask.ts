// Memory extraction as a group_day task: the extract runs on the shared day prefix,
// then consolidation into stored memory goes through MemoryExtractService like any extract.
//
// Only the extract call shares the prefix. Consolidation (memory.consolidate) reads stored
// memory and the new facts, not the chat, so it keeps memory's own provider and model.

import { TOKEN_BUDGET } from '@/ai/tokenBudget';
import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { FanoutRun, FanoutTask, FanoutTaskOutput } from '@/fanout/core/types';
import type { MemoryExtractService } from './MemoryExtractService';
import { MEMORY_JOB_TIMEOUT_MS, type MemoryLLMOptions } from './memoryLLM';

export class GroupDayMemoryTask implements FanoutTask<GroupDayContext, null> {
  static readonly NAME = 'memory';
  readonly name = GroupDayMemoryTask.NAME;
  readonly tools = [];
  readonly limits = { maxTokens: TOKEN_BUDGET.document, timeout: MEMORY_JOB_TIMEOUT_MS, maxToolRounds: 1 };

  constructor(
    private readonly extractService: MemoryExtractService,
    private readonly mergeOptions: MemoryLLMOptions,
  ) {}

  parseParams(): null {
    return null;
  }

  suffix(): string {
    return this.extractService.renderPrefixedExtractTask();
  }

  async handle(output: FanoutTaskOutput, run: FanoutRun<GroupDayContext>): Promise<void> {
    await this.extractService.consolidateExtractOutput(run.ctx.groupId, output.text, this.mergeOptions);
  }
}
