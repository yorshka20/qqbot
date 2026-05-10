/**
 * Tests for the applicableSources hook filter.
 *
 * Strategy: directly exercise the wrapping logic that PluginManager inserts
 * into HookManager when applicableSources is declared, without loading the
 * full plugin filesystem. We build two minimal HookHandler closures — one
 * annotated, one not — register them via HookManager.addHandler, and verify
 * that the source filter skips the annotated one for non-matching sources.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { MessageSource } from '@/conversation/sources';
import { HookManager } from '@/hooks/HookManager';
import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext, HookHandler } from '@/hooks/types';
import { logger } from '@/utils/logger';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(source: MessageSource): HookContext {
  const metadata = new HookMetadataMap();
  return {
    message: {
      id: 'test',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId: 1,
      messageType: source === 'qq-private' ? 'private' : 'group',
      message: '',
      segments: [],
    },
    context: {
      userMessage: '',
      history: [],
      userId: 1,
      messageType: source === 'qq-private' ? 'private' : 'group',
      metadata: new Map(),
    },
    metadata,
    source,
  };
}

/**
 * Build the source-filter wrapper exactly as PluginManager does.
 */
function wrapWithSourceFilter(
  handler: HookHandler,
  applicableSources: readonly MessageSource[],
  pluginName: string,
  hookName: string,
): HookHandler {
  return (ctx) => {
    if (!applicableSources.includes(ctx.source)) {
      logger.debug(
        `[Hook] skipped due to applicableSources mismatch | plugin=${pluginName} hook=${hookName} source=${ctx.source}`,
      );
      return true;
    }
    return handler(ctx);
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applicableSources hook filter', () => {
  it('source-match: both annotated and unannotated handlers run', async () => {
    const hookManager = new HookManager();
    const calls: string[] = [];

    // Unannotated handler (no source filter)
    const unannotated: HookHandler = (_ctx) => {
      calls.push('unannotated');
      return true;
    };

    // Annotated handler (only qq-private)
    const annotatedRaw: HookHandler = (_ctx) => {
      calls.push('annotated');
      return true;
    };
    const annotated = wrapWithSourceFilter(annotatedRaw, ['qq-private'], 'test-plugin', 'onMessageReceived');

    hookManager.addHandler('onMessageReceived', unannotated, 700);
    hookManager.addHandler('onMessageReceived', annotated, 701);

    const ctx = makeCtx('qq-private');
    await hookManager.execute('onMessageReceived', ctx);

    expect(calls).toContain('unannotated');
    expect(calls).toContain('annotated');
  });

  it('source-mismatch: annotated handler is skipped, unannotated runs', async () => {
    const hookManager = new HookManager();
    const calls: string[] = [];

    const unannotated: HookHandler = (_ctx) => {
      calls.push('unannotated');
      return true;
    };

    const annotatedRaw: HookHandler = (_ctx) => {
      calls.push('annotated');
      return true;
    };
    const annotated = wrapWithSourceFilter(annotatedRaw, ['qq-private'], 'test-plugin', 'onMessageReceived');

    hookManager.addHandler('onMessageReceived', unannotated, 700);
    hookManager.addHandler('onMessageReceived', annotated, 701);

    const debugSpy = mock(() => undefined);
    const originalDebug = logger.debug.bind(logger);
    logger.debug = debugSpy;
    try {
      const ctx = makeCtx('bilibili-danmaku');
      await hookManager.execute('onMessageReceived', ctx);

      expect(calls).toContain('unannotated');
      expect(calls).not.toContain('annotated');

      // Verify the mismatch debug log fired
      const mismatchCalled = (debugSpy.mock.calls as string[][]).some((args) =>
        args[0]?.includes('applicableSources mismatch'),
      );
      expect(mismatchCalled).toBe(true);
    } finally {
      logger.debug = originalDebug;
    }
  });

  it('applicableSources mismatch debug log contains expected text', async () => {
    const hookManager = new HookManager();
    const debugSpy = mock(() => undefined);
    const originalDebug = logger.debug.bind(logger);
    logger.debug = debugSpy;

    try {
      const handler: HookHandler = (_ctx) => true;
      const wrapped = wrapWithSourceFilter(handler, ['qq-private'], 'my-plugin', 'onMessageReceived');
      hookManager.addHandler('onMessageReceived', wrapped, 700);

      const ctx = makeCtx('discord');
      await hookManager.execute('onMessageReceived', ctx);

      const mismatchLog = (debugSpy.mock.calls as string[][]).find((args) =>
        args[0]?.includes('applicableSources mismatch'),
      );
      expect(mismatchLog).toBeDefined();
      expect(mismatchLog![0]).toContain('discord');
    } finally {
      logger.debug = originalDebug;
    }
  });
});
