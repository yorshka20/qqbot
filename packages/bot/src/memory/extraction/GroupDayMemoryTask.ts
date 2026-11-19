// Memory extraction as a group_day task. It reads the same day log as the other tasks, but
// runs as a memory batch job instead of in the fan-out: its request (the group_day system
// prompt; the day log followed by the extraction task) is queued, and the answer is
// consolidated when the batch returns.

import type { GroupDayContext } from '@/fanout/contexts/groupDay/GroupDayFanout';
import type { DeferredFanoutRequest, DeferredFanoutTask, FanoutRun } from '@/fanout/core/types';
import type { MemoryBatchQueue } from '../batch/MemoryBatchQueue';
import type { MemoryExtractService } from './MemoryExtractService';

export class GroupDayMemoryTask implements DeferredFanoutTask<GroupDayContext, null> {
  static readonly NAME = 'memory';
  readonly mode = 'deferred';
  readonly name = GroupDayMemoryTask.NAME;

  constructor(
    private readonly extractService: MemoryExtractService,
    private readonly queue: MemoryBatchQueue,
  ) {}

  parseParams(): null {
    return null;
  }

  suffix(): string {
    return this.extractService.renderPrefixedExtractTask();
  }

  async defer(request: DeferredFanoutRequest, run: FanoutRun<GroupDayContext>): Promise<void> {
    await this.queue.enqueuePrompt(run.ctx.groupId, request);
  }
}
