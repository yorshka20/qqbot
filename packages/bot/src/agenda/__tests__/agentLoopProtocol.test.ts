import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { SubAgentOrchestrator } from '@/agent/SubAgentOrchestrator';
import type { PromptManager } from '@/ai';
import type { AIService } from '@/ai/AIService';
import type { LLMService } from '@/ai/services/LLMService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { Config } from '@/core/config';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { HookManager } from '@/hooks/HookManager';
import type { ToolManager } from '@/tools/ToolManager';
import { type ActionHandlerContext, ActionHandlerRegistry } from '../ActionHandlerRegistry';
import { AgentLoop } from '../AgentLoop';
import type { AgendaItem } from '../types';

function makeLoop(preferredProtocol: ProtocolName, sent: Array<{ groupId: number; protocol: ProtocolName }>) {
  const messageAPI = {
    sendGroupMessage: async (groupId: number, _message: unknown, protocol: ProtocolName) => {
      sent.push({ groupId, protocol });
      return 1;
    },
  } as unknown as MessageAPI;
  const config = { getAPIConfig: () => ({ strategy: 'priority', preferredProtocol }) } as unknown as Config;
  return new AgentLoop(
    {} as LLMService,
    messageAPI,
    {} as ConversationHistoryService,
    {} as PromptManager,
    {} as ToolManager,
    {} as HookManager,
    {} as AIService,
    {} as SubAgentOrchestrator,
    config,
  );
}

const item = {
  id: 1,
  name: '测试任务',
  groupId: '10000001',
  userId: '10000002',
  triggerType: 'cron',
  intent: '',
  actionType: 'action',
  actionTarget: 'probe',
  cooldownMs: 60_000,
  maxSteps: 3,
  enabled: true,
} as unknown as AgendaItem;

describe('AgentLoop send protocol', () => {
  it('sends on the configured api.preferredProtocol and hands it to the action handler', async () => {
    const sent: Array<{ groupId: number; protocol: ProtocolName }> = [];
    const loop = makeLoop('satori', sent);
    const seen: ActionHandlerContext[] = [];
    const registry = new ActionHandlerRegistry();
    registry.register({
      name: 'probe',
      execute: async (ctx) => {
        seen.push(ctx);
        return '早上好';
      },
    });

    await loop.runAction(item, { eventType: 'cron', userId: '10000002', botSelfId: '10000003' }, registry);

    expect(seen.map((ctx) => ctx.protocol)).toEqual(['satori']);
    expect(sent).toEqual([{ groupId: 10000001, protocol: 'satori' }]);
  });
});
