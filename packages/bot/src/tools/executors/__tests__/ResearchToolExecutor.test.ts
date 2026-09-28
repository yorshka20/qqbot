import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { SubAgentOrchestrator } from '@/agent/SubAgentOrchestrator';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { RetrievalService } from '@/services/retrieval/RetrievalService';
import type { ToolExecutionContext } from '../../types';
import { ResearchToolExecutor } from '../ResearchToolExecutor';

describe('ResearchToolExecutor', () => {
  it('hands slow research to the background and delivers the final result', async () => {
    let finish!: (result: string) => void;
    const orchestrator = {
      run: () => new Promise<string>((resolve) => (finish = resolve)),
    } as unknown as SubAgentOrchestrator;
    const retrieval = {
      getPageContentFetchService: () => ({ isEnabled: () => false }),
    } as unknown as RetrievalService;
    const delivered: string[] = [];
    const messageAPI = {
      sendFromContext: async (content: string) => {
        delivered.push(content);
        return { message_seq: 123 };
      },
    } as unknown as MessageAPI;
    const persisted: string[] = [];
    const history = {
      appendBotMessageToSession: async (_target: unknown, content: string) => {
        persisted.push(content);
      },
    } as unknown as ConversationHistoryService;
    const executor = new ResearchToolExecutor(orchestrator, retrieval, messageAPI, history);
    const context = {
      userId: 10000001,
      messageType: 'private',
      hookContext: {
        message: { userId: 10000001, messageType: 'private', protocol: 'milky' },
        metadata: new Map(),
      },
    } as unknown as ToolExecutionContext;

    const result = await executor.execute(
      { type: 'research', executor: 'research', parameters: { task: '查证测试命题' } },
      context,
    );
    expect(result.success).toBe(true);
    expect(result.endTurn).toBe(true);
    expect(delivered).toEqual([]);

    finish('有据可查');
    await Bun.sleep(0);
    expect(delivered).toEqual(['调研结果（回应此前的问题）：\n有据可查']);
    expect(persisted).toEqual(delivered);
  }, 10_000);
});
