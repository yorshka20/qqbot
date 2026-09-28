import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { ToolManager } from '../ToolManager';
import type { ToolExecutionContext } from '../types';

const hooks = { execute: async () => true } as unknown as HookManager;
const context = { userId: 10000001, messageType: 'private' } as ToolExecutionContext;

function stalledManager(timeoutMs?: number): { manager: ToolManager; wasAborted: () => boolean } {
  const manager = new ToolManager();
  manager.registerTool({
    name: 'stalled',
    description: 'test',
    executor: 'stalled',
    visibility: { subagent: true },
    timeoutMs,
  });
  let aborted = false;
  manager.registerExecutor({
    name: 'stalled',
    execute: (_call, executionContext) =>
      new Promise(() => {
        executionContext.signal?.addEventListener('abort', () => {
          aborted = true;
        });
      }),
  });
  return { manager, wasAborted: () => aborted };
}

describe('ToolManager execution deadline', () => {
  it('honours the budget declared on the tool and aborts the stalled executor', async () => {
    const { manager, wasAborted } = stalledManager(50);

    const result = await manager.execute(
      { type: 'stalled', executor: 'stalled', parameters: {} },
      context,
      hooks,
      {} as HookContext,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(wasAborted()).toBe(true);
  });

  it('falls back to the default budget when the tool declares none', async () => {
    const { manager, wasAborted } = stalledManager();

    const settled = await Promise.race([
      manager
        .execute({ type: 'stalled', executor: 'stalled', parameters: {} }, context, hooks, {} as HookContext)
        .then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200)),
    ]);

    expect(settled).toBe('pending');
    expect(wasAborted()).toBe(false);
  });
});
