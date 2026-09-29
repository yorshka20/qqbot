import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { SubAgentOrchestrator } from '@/agent/SubAgentOrchestrator';
import type { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { ToolExecutionContext } from '../../types';
import { ResearchToolExecutor } from '../ResearchToolExecutor';

describe('ResearchToolExecutor', () => {
  it('returns the subagent conclusion to the calling model', async () => {
    const orchestrator = {
      run: async () => '有据可查',
    } as unknown as SubAgentOrchestrator;
    const retrieval = {
      getPageContentFetchService: () => ({ isEnabled: () => false }),
    } as unknown as RetrievalService;
    const executor = new ResearchToolExecutor(orchestrator, retrieval);
    const context = { userId: 10000001, messageType: 'private' } as unknown as ToolExecutionContext;

    const result = await executor.execute(
      { type: 'research', executor: 'research', parameters: { task: '查证测试命题' } },
      context,
    );

    expect(result).toMatchObject({ success: true, reply: '有据可查' });
    expect(result.endTurn).toBeUndefined();
  });
});
