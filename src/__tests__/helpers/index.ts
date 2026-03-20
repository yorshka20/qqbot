/**
 * Shared test helpers for the qqbot test suite.
 *
 * Provides reusable factories for common test setup patterns:
 * - HookContext creation
 * - ToolExecutionContext creation
 * - Mock ToolManager with configurable tools/executors
 * - Mock tool executors (search, memory, etc.)
 * - Plugin initialization helpers
 * - DI container helpers
 */

import 'reflect-metadata';

import { HookMetadataMap } from '@/hooks/metadata';
import type { HookContext } from '@/hooks/types';
import type { ToolCall, ToolExecutionContext, ToolExecutor, ToolResult, ToolSpec } from '@/tools/types';
import type { ToolManager } from '@/tools/ToolManager';

// ── HookContext Factory ──

export interface HookContextOptions {
  messageText: string;
  messageType?: 'private' | 'group';
  userId?: number;
  groupId?: number;
  botSelfId?: string;
  /** Pre-set metadata entries */
  metadataEntries?: Record<string, unknown>;
  /** Attach a reply */
  reply?: HookContext['reply'];
  /** Attach a parsed command */
  command?: HookContext['command'];
}

/**
 * Create a minimal HookContext for testing.
 * Covers the most common shape used across 8+ test files.
 */
export function createHookContext(opts: HookContextOptions): HookContext {
  const {
    messageText,
    messageType = 'group',
    userId = 456,
    groupId,
    botSelfId = '123',
    metadataEntries,
    reply,
    command,
  } = opts;

  const resolvedGroupId = groupId ?? (messageType === 'group' ? 1 : undefined);
  const metadata = new HookMetadataMap();
  metadata.set('botSelfId', botSelfId);

  if (metadataEntries) {
    for (const [key, value] of Object.entries(metadataEntries)) {
      metadata.set(key as keyof import('@/hooks/metadata').HookContextMetadata, value as never);
    }
  }

  return {
    message: {
      id: 'm1',
      type: 'message',
      timestamp: Date.now(),
      protocol: 'milky',
      userId,
      groupId: resolvedGroupId,
      messageType,
      message: messageText,
      segments: [],
    },
    context: {
      userMessage: messageText,
      history: [],
      userId,
      groupId: resolvedGroupId,
      messageType,
      metadata: new Map(),
    },
    metadata,
    ...(reply ? { reply } : {}),
    ...(command ? { command } : {}),
  } as HookContext;
}

// ── ToolExecutionContext Factory ──

export interface ToolExecutionContextOptions {
  userId?: number;
  groupId?: number;
  messageType?: 'private' | 'group';
  conversationId?: string;
  messageId?: string;
  hookContext?: HookContext;
}

/**
 * Create a ToolExecutionContext for tool executor tests.
 */
export function createToolExecutionContext(opts: ToolExecutionContextOptions = {}): ToolExecutionContext {
  return {
    userId: opts.userId ?? 12345,
    groupId: opts.groupId ?? 67890,
    messageType: opts.messageType ?? 'group',
    conversationId: opts.conversationId ?? 'test-conv',
    messageId: opts.messageId ?? 'test-msg',
    ...(opts.hookContext ? { hookContext: opts.hookContext } : {}),
  };
}

// ── Mock ToolManager ──

/**
 * Create a mock ToolManager with the given tool specs and executor map.
 *
 * Usage:
 * ```ts
 * const tm = createMockToolManager(
 *   [{ name: 'search', description: 'Search', executor: 'search', visibility: ['reply'] }],
 *   { search: mySearchExecutor },
 * );
 * ```
 */
export function createMockToolManager(
  specs: ToolSpec[],
  executors: Record<string, ToolExecutor>,
): ToolManager {
  return {
    getAllTools: () => specs,
    getExecutor: (name: string) => executors[name] ?? null,
    getTool: (name: string) => specs.find((s) => s.name === name) ?? null,
  } as unknown as ToolManager;
}

/**
 * Shortcut to create a ToolSpec with common defaults.
 */
export function createToolSpec(overrides: Partial<ToolSpec> & { name: string; executor: string }): ToolSpec {
  return {
    description: `Mock ${overrides.name} tool`,
    visibility: ['reply'],
    ...overrides,
  } as ToolSpec;
}

// ── Mock Tool Executors ──

/**
 * A search tool executor that returns JSON results for any query.
 */
export class MockSearchExecutor implements ToolExecutor {
  name = 'search';
  async execute(call: ToolCall): Promise<ToolResult> {
    const query = call.parameters?.query as string;
    return {
      success: true,
      reply: JSON.stringify({
        results: [
          { title: `Result 1 for "${query}"`, url: 'https://example.com/1' },
          { title: `Result 2 for "${query}"`, url: 'https://example.com/2' },
        ],
      }),
    };
  }
}

/**
 * A memory tool executor with store/retrieve actions.
 */
export class MockMemoryExecutor implements ToolExecutor {
  name = 'memory';
  private store = new Map<string, string>();

  async execute(call: ToolCall): Promise<ToolResult> {
    const action = call.parameters?.action as string;
    const key = call.parameters?.key as string;
    const value = call.parameters?.value as string;

    if (action === 'store') {
      this.store.set(key, value);
      return { success: true, reply: `Stored "${key}"` };
    }
    if (action === 'retrieve') {
      const val = this.store.get(key);
      return val
        ? { success: true, reply: val }
        : { success: false, reply: `Key "${key}" not found`, error: 'not_found' };
    }
    return { success: false, reply: 'Unknown action', error: 'unknown_action' };
  }
}

/**
 * A tool executor that always fails (for error handling tests).
 */
export class MockFailingExecutor implements ToolExecutor {
  name = 'failing_tool';
  constructor(private errorMessage = 'upstream service unavailable') {}

  async execute(): Promise<ToolResult> {
    throw new Error(this.errorMessage);
  }
}

/**
 * A tool executor with configurable delay (for timeout tests).
 */
export class MockSlowExecutor implements ToolExecutor {
  name = 'slow_tool';
  constructor(private delayMs = 100) {}

  async execute(): Promise<ToolResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { success: true, reply: 'slow result' };
  }
}

// ── Plugin Init Helper ──

/**
 * Minimal plugin context stub used by all plugin tests.
 * Matches the `{ api: {} as never, events: {} as never }` pattern.
 */
export function createPluginContextStub() {
  return { api: {} as never, events: {} as never };
}

/**
 * Initialize a plugin with config for testing.
 *
 * Usage:
 * ```ts
 * const plugin = await initPlugin(WhitelistPlugin, { groupIds: ['1'] });
 * ```
 */
export async function initPlugin<T extends { loadConfig: (ctx: unknown, cfg: unknown) => void; onInit?: () => Promise<void> }>(
  PluginClass: new (meta: { name: string; version: string; description: string }) => T,
  config: Record<string, unknown> = {},
  pluginName?: string,
): Promise<T> {
  const name = pluginName ?? PluginClass.name.replace(/Plugin$/, '').toLowerCase();
  const plugin = new PluginClass({ name, version: 'test', description: 'test' });
  plugin.loadConfig(createPluginContextStub(), { name, enabled: true, config });
  await plugin.onInit?.();
  return plugin;
}

// ── DI Container Helpers ──

/**
 * Common mock service stubs for DI container registration.
 * Use with `container.registerInstance(DITokens.XXX, MOCK_SERVICES.xxx, { allowOverride: true })`.
 */
export const MOCK_SERVICES = {
  llmService: {
    generateLite: async () => ({ text: 'true' }),
  },
  threadService: {
    getActiveThread: () => null,
    hasActiveThread: () => false,
  },
  config: {
    getAIConfig: () => undefined,
  },
  messageApi: {
    getResourceTempUrl: async () => null,
    sendFromContext: async () => ({ success: true }),
    sendForwardFromContext: async () => ({ success: true }),
  },
  conversationConfigService: {
    getUseForwardMsg: async () => false,
  },
  retrievalService: {
    getPageContentFetchService: () => ({
      isEnabled: () => false,
      fetchPages: async () => [],
    }),
  },
};

// ── ToolCall Factory ──

/**
 * Create a ToolCall for testing.
 */
export function createToolCall(
  toolName: string,
  parameters: Record<string, unknown> = {},
  executor?: string,
): ToolCall {
  return {
    type: toolName,
    executor: executor ?? toolName,
    parameters,
  };
}
