import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { LLMService } from '@/ai/services/LLMService';
import type { LLMTraceEntry } from '@/ai/types';
import { ConversationMessageSender } from '@/conversation/ConversationMessageSender';
import { getContainer } from '@/core/DIContainer';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import { TokenUsageService } from '@/services/tokenUsage/TokenUsageService';
import { UsageNoticeService } from '@/services/tokenUsage/UsageNoticeService';
import { UsageTrackingPlugin } from '../UsageTrackingPlugin';

function makeContext(): HookContext {
  const metadata = new HookMetadataMap();
  metadata.set('sessionId', 'group:10000001');
  metadata.set('groupId', 10000001);
  metadata.set('aiUsage', {
    type: 'llm',
    provider: 'deepseek',
    model: 'deepseek-flash',
    source: 'reply',
    promptTokens: 70_000,
    cachedPromptTokens: 50_000,
    completionTokens: 100,
    totalTokens: 70_100,
    openingPromptTokens: 65_000,
  });
  return {
    message: { userId: 20000001, protocol: 'milky', sender: { nickname: '测试用户甲' } },
    metadata,
  } as unknown as HookContext;
}

async function makePlugin(notices: string[]) {
  const noticeService = { record: vi.fn(async () => notices) };
  const sender = { sendText: vi.fn(async (_context: HookContext, text: string) => text) };
  const container = getContainer();
  container.registerInstance(UsageNoticeService, noticeService as unknown as UsageNoticeService);
  container.registerInstance(ConversationMessageSender, sender as unknown as ConversationMessageSender);
  const observers: Array<(entry: LLMTraceEntry) => void> = [];
  const llmService = { addTraceObserver: (observer: (entry: LLMTraceEntry) => void) => observers.push(observer) };
  const tokenUsage = { recordSystemLLM: vi.fn(async () => null) };
  container.registerInstance(LLMService, llmService as unknown as LLMService);
  container.registerInstance(TokenUsageService, tokenUsage as unknown as TokenUsageService);
  const plugin = new UsageTrackingPlugin({ name: 'usage-tracking', version: '1.0.0', description: '' });
  await plugin.onInit();
  return { plugin, noticeService, sender, tokenUsage, trace: (entry: Partial<LLMTraceEntry>) => observers.forEach((o) => o(entry as LLMTraceEntry)) };
}

describe('UsageTrackingPlugin', () => {
  afterEach(() => {
    getContainer().clear();
  });

  describe('trace observer', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 2 };

    it('records a call outside the reply path as system usage', async () => {
      const { tokenUsage, trace } = await makePlugin([]);

      trace({ provider: 'deepseek', resolvedModel: 'deepseek-flash', response: { text: '', usage } });

      expect(tokenUsage.recordSystemLLM).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-flash', usage });
    });

    it('skips a call whose caller records the usage itself', async () => {
      const { tokenUsage, trace } = await makePlugin([]);

      trace({ provider: 'deepseek', usageRecordedByCaller: true, response: { text: '', usage } });

      expect(tokenUsage.recordSystemLLM).not.toHaveBeenCalled();
    });

    it('skips a call that reported no usage', async () => {
      const { tokenUsage, trace } = await makePlugin([]);

      trace({ provider: 'deepseek', response: { text: '' } });

      expect(tokenUsage.recordSystemLLM).not.toHaveBeenCalled();
    });
  });

  it('records the usage once, with the opening prompt size, and consumes it', async () => {
    const { plugin, noticeService } = await makePlugin([]);
    const context = makeContext();

    await plugin.onAIGenerationComplete(context);
    await plugin.onAIGenerationComplete(context);

    expect(noticeService.record).toHaveBeenCalledTimes(1);
    expect(noticeService.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 20000001, groupId: 10000001, promptTokens: 70_000, cachedPromptTokens: 50_000 }),
      { sessionId: 'group:10000001', openingPromptTokens: 65_000 },
    );
    expect(context.metadata.get('aiUsage')).toBeUndefined();
  });

  it('holds the notices until the message completes, after the reply went out', async () => {
    const { plugin, sender } = await makePlugin(['💸 notice', '📏 notice']);
    const context = makeContext();

    await plugin.onAIGenerationComplete(context);
    expect(sender.sendText).not.toHaveBeenCalled();

    await plugin.onMessageComplete(context);
    expect(sender.sendText.mock.calls.map((call) => call[1])).toEqual(['💸 notice', '📏 notice']);

    await plugin.onMessageComplete(context);
    expect(sender.sendText).toHaveBeenCalledTimes(2);
  });
});
