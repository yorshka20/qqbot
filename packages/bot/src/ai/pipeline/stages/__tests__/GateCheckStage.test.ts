import 'reflect-metadata';
import { describe, expect, it, vi } from 'bun:test';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import type { UsageBudgetService } from '@/services/tokenUsage/UsageBudgetService';
import type { ReplyPipelineContext } from '../../ReplyPipelineContext';
import { GateCheckStage } from '../GateCheckStage';

function makeCtx(): ReplyPipelineContext {
  const metadata = new HookMetadataMap();
  metadata.set('whitelistDenied', false);
  const hookContext = {
    message: { userId: 20000001, protocol: 'milky', messageType: 'private' },
    metadata,
  } as unknown as HookContext;
  return { hookContext, interrupted: false } as unknown as ReplyPipelineContext;
}

function makeStage(exceeded: { spentUsd: number; limitUsd: number } | null) {
  const hookManager = { execute: vi.fn(async () => true) } as unknown as HookManager;
  const budget = { checkUser: vi.fn(async () => exceeded) } as unknown as UsageBudgetService;
  return { stage: new GateCheckStage(hookManager, budget), hookManager };
}

describe('GateCheckStage — budget', () => {
  it('answers an over-budget sender with a notice and runs no LLM hook', async () => {
    const { stage, hookManager } = makeStage({ spentUsd: 0.52, limitUsd: 0.5 });
    const ctx = makeCtx();

    await stage.execute(ctx);

    expect(ctx.interrupted).toBe(true);
    expect(ctx.hookContext.reply?.segments[0]).toEqual({
      type: 'text',
      data: { text: '你今天的 AI 额度用完了（$0.52 / $0.50），明天自动恢复。' },
    });
    expect(hookManager.execute).not.toHaveBeenCalled();
  });

  it('lets a sender within budget through to the hooks', async () => {
    const { stage, hookManager } = makeStage(null);
    const ctx = makeCtx();

    await stage.execute(ctx);

    expect(ctx.interrupted).toBe(false);
    expect(ctx.hookContext.reply).toBeUndefined();
    expect(hookManager.execute).toHaveBeenCalledWith('onMessageBeforeAI', ctx.hookContext);
  });
});
