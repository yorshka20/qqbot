import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { HookManager } from '@/hooks/HookManager';
import type { HookContext } from '@/hooks/types';
import { ToolManager } from '../ToolManager';
import { TOOL_EXECUTION_TIMEOUT_MS } from '../toolDeadline';
import type { ToolExecutionContext } from '../types';

describe('ToolManager execution deadline', () => {
  it('returns a timeout result and aborts a stalled executor', async () => {
    const manager = new ToolManager();
    manager.registerTool({ name: 'stalled', description: 'test', executor: 'stalled', visibility: { subagent: true } });
    let aborted = false;
    manager.registerExecutor({
      name: 'stalled',
      execute: (_call, context) =>
        new Promise(() => {
          context.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });
    const hooks = { execute: async () => true } as unknown as HookManager;
    const started = Date.now();
    const result = await manager.execute(
      { type: 'stalled', executor: 'stalled', parameters: {} },
      { userId: 10000001, messageType: 'private' } as ToolExecutionContext,
      hooks,
      {} as HookContext,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(TOOL_EXECUTION_TIMEOUT_MS + 1_000);
  }, TOOL_EXECUTION_TIMEOUT_MS + 2_000);
});
