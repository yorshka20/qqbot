import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { SubAgentExecutor } from '../SubAgentExecutor';
import { SubAgentManager } from '../SubAgentManager';
import { SubAgentOrchestrator } from '../SubAgentOrchestrator';
import { SubAgentType } from '../types';

describe('SubAgentOrchestrator.run', () => {
  it('spawns the session, runs it and returns the output it recorded', async () => {
    const manager = new SubAgentManager();
    const executed: string[] = [];
    const executor = {
      execute: async (sessionId: string) => {
        executed.push(sessionId);
        manager.updateSessionStatus(sessionId, 'running');
        manager.updateSessionStatus(sessionId, 'completed', 'done');
        return 'done';
      },
    } as unknown as SubAgentExecutor;
    const orchestrator = new SubAgentOrchestrator(manager, executor);

    const output = await orchestrator.run(SubAgentType.RESEARCH, { description: 'task', input: {} }, undefined, 'agent:p');

    expect(output).toBe('done');
    const [session] = manager.listByParent('agent:p');
    expect(executed).toEqual([session.id]);
    expect(session.type).toBe(SubAgentType.RESEARCH);
    expect(session.status).toBe('completed');
  });
});
