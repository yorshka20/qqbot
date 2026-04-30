// AvatarMemoryExtractionCoordinator — unit tests for the debounced extract
// scheduler. Uses Bun's fake timers so tests don't actually wait `debounceMs`.
//
// Coverage targets:
//   - `enabled=false` makes `schedule()` a no-op (no timer, no work)
//   - `enabled=true` schedules; subsequent `schedule()` resets the timer
//   - On fire, the coordinator reads entries, filters bot replies out for
//     the minimum check, and calls MemoryExtractService.extractAndUpsert
//     with the thread's groupId
//   - Below `minUserEntries`, the fire is a no-op (no LLM call)
//   - `runNow()` bypasses the debounce and runs immediately (useful for
//     `/memory extract` style admin commands + tests)
//   - Provider resolution precedence (override → taskProviders.memoryExtract
//     → avatar.llmProvider → defaultProviders.llm)

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { container } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';
import type { MemoryExtractService } from '@/memory';
import type { AvatarSource } from '../../types';
import { AvatarMemoryExtractionCoordinator } from '../AvatarMemoryExtractionCoordinator';
import type { AvatarSessionService } from '../AvatarSessionService';

/**
 * Default source used across tests. Must match the default allowlist in
 * `AvatarMemoryExtractionConfig.allowedSources` so existing tests keep
 * exercising the extract path. The `schedules only when source is in
 * allowlist` test explicitly overrides.
 */
const DEFAULT_SOURCE: AvatarSource = 'bilibili-danmaku-batch';

interface FakeEntry {
  messageId: string;
  userId: string | number;
  nickname?: string;
  content: string;
  isBotReply: boolean;
  createdAt: Date;
  wasAtBot?: boolean;
}

function makeEntry(partial: Partial<FakeEntry> & { content: string; isBotReply: boolean }): FakeEntry {
  return {
    messageId: partial.messageId ?? `m-${Math.random()}`,
    userId: partial.userId ?? (partial.isBotReply ? 0 : 'user-1'),
    nickname: partial.nickname,
    content: partial.content,
    isBotReply: partial.isBotReply,
    createdAt: partial.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    wasAtBot: partial.wasAtBot,
  };
}

interface CoordinatorEnv {
  coordinator: AvatarMemoryExtractionCoordinator;
  fakeConfig: Record<string, unknown>;
  fakeSession: {
    getGroupId: ReturnType<typeof mock>;
    getHistoryEntries: ReturnType<typeof mock>;
  };
  extractService: {
    extractAndUpsert: ReturnType<typeof mock>;
  };
}

interface SetupOptions {
  enabled?: boolean;
  debounceMs?: number;
  minUserEntries?: number;
  maxEntries?: number;
  provider?: string;
  avatarLlmProvider?: string;
  taskProvider?: string;
  defaultProvider?: string;
  groupId?: string;
  entries?: FakeEntry[];
  /** Override the allowlist; default matches production (`['bilibili-danmaku-batch']`). */
  allowedSources?: string[];
  /** If false, the coordinator won't find MemoryExtractService at all. */
  registerExtractService?: boolean;
}

function setup(opts: SetupOptions = {}): CoordinatorEnv {
  // Isolate DI container per test so we don't leak instances.
  container.reset();

  const fakeConfig: Record<string, unknown> = {
    avatar: {
      llmProvider: opts.avatarLlmProvider,
      memoryExtraction: {
        enabled: opts.enabled ?? true,
        debounceMs: opts.debounceMs ?? 50,
        minUserEntries: opts.minUserEntries ?? 2,
        maxEntries: opts.maxEntries ?? 80,
        // Explicit `null` isn't allowed; the suite always passes an array so
        // behavior is deterministic. Production default (['bilibili-danmaku-batch'])
        // is re-exercised in almost every test.
        allowedSources: opts.allowedSources ?? ['bilibili-danmaku-batch'],
        provider: opts.provider,
      },
    },
    ai: {
      defaultProviders: { llm: opts.defaultProvider ?? 'deepseek' },
      taskProviders: opts.taskProvider ? { memoryExtract: opts.taskProvider } : undefined,
    },
  };

  const configShim: Pick<Config, 'getAvatarConfig' | 'getAIConfig'> = {
    getAvatarConfig: () => fakeConfig.avatar as Record<string, unknown>,
    getAIConfig: () => fakeConfig.ai as ReturnType<Config['getAIConfig']>,
  };

  const fakeSession = {
    // Default groupId matches `DEFAULT_SOURCE` (`bilibili-danmaku-batch`) so
    // the groupId we assert against lines up with the source we schedule with.
    getGroupId: mock(() => opts.groupId ?? 'live2d:bilibili-live:room-6940826'),
    getHistoryEntries: mock(() => opts.entries ?? []),
  };

  const extractService = {
    extractAndUpsert: mock(async () => undefined),
  };

  if (opts.registerExtractService !== false) {
    container.registerInstance(DITokens.MEMORY_EXTRACT_SERVICE, extractService as unknown as MemoryExtractService);
  }

  const coordinator = new AvatarMemoryExtractionCoordinator(
    configShim as Config,
    fakeSession as unknown as AvatarSessionService,
  );

  return { coordinator, fakeConfig, fakeSession, extractService };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('AvatarMemoryExtractionCoordinator', () => {
  beforeEach(() => {
    // No global setup needed; each test calls setup() which resets container.
  });

  test('is a no-op when avatar.memoryExtraction.enabled is false', async () => {
    const env = setup({ enabled: false });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    // Give any stray debounce a chance to fire even at max debounceMs.
    await sleep(80);
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
    expect(env.fakeSession.getGroupId).not.toHaveBeenCalled();
  });

  test('skips scheduling when groupId cannot be resolved', async () => {
    const env = setup({ enabled: true, groupId: '' });
    // Force getGroupId to return undefined to simulate a missing thread.
    env.fakeSession.getGroupId = mock(() => undefined);
    env.coordinator.schedule('thread-missing', DEFAULT_SOURCE);
    await sleep(80);
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
  });

  test('fires extractAndUpsert after debounce with the thread groupId', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [
        makeEntry({ content: 'hello', isBotReply: false, userId: 'u-1' }),
        makeEntry({ content: '你好！', isBotReply: true }),
      ],
      groupId: 'live2d:bilibili-live:room-6940826',
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    expect(env.extractService.extractAndUpsert).toHaveBeenCalledTimes(1);
    const [groupId, text, options] = env.extractService.extractAndUpsert.mock.calls[0];
    expect(groupId).toBe('live2d:bilibili-live:room-6940826');
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(options.provider).toBe('deepseek'); // default fallback
  });

  test('skips scheduling for sources not in allowedSources (avatar-cmd / livemode by default)', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'test probe', isBotReply: false, userId: 'admin' })],
      // Production default — avatar-cmd + livemode NOT in allowlist.
    });
    env.coordinator.schedule('thread-avatar', 'avatar-cmd');
    env.coordinator.schedule('thread-livemode', 'livemode-private-batch');
    await sleep(80);
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
    // getGroupId should not even be reached — allowlist check is first.
    expect(env.fakeSession.getGroupId).not.toHaveBeenCalled();
  });

  test('respects a custom allowedSources widening the allowlist', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
      allowedSources: ['avatar-cmd'],
      groupId: 'live2d:avatar-cmd:global',
    });
    env.coordinator.schedule('thread-1', 'avatar-cmd');
    await sleep(80);
    expect(env.extractService.extractAndUpsert).toHaveBeenCalledTimes(1);
    const [groupId] = env.extractService.extractAndUpsert.mock.calls[0];
    expect(groupId).toBe('live2d:avatar-cmd:global');
  });

  test('runNow also honors the allowlist (cannot bypass by force)', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 10_000,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
      // Default allowlist does NOT include avatar-cmd.
    });
    await env.coordinator.runNow('thread-1', 'avatar-cmd');
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
  });

  test('collapses bursts: repeat schedule() within debounce runs extract once', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 30,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hello', isBotReply: false, userId: 'u-1' })],
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(10);
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(10);
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    expect(env.extractService.extractAndUpsert).toHaveBeenCalledTimes(1);
  });

  test('skips fire when below minUserEntries (ignoring bot replies)', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 3,
      entries: [
        makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' }),
        makeEntry({ content: '...', isBotReply: true }),
        makeEntry({ content: 'yo', isBotReply: false, userId: 'u-1' }),
      ],
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    // Only 2 non-bot entries; minUserEntries=3 → no extract.
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
  });

  test('caps feed length at maxEntries (keeps the tail)', async () => {
    const entries: FakeEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeEntry({
          content: `msg-${i}`,
          isBotReply: i % 2 === 1,
          userId: i % 2 === 0 ? `u-${i}` : 0,
        }),
      );
    }
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      maxEntries: 4,
      entries,
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    expect(env.extractService.extractAndUpsert).toHaveBeenCalledTimes(1);
    const [, text] = env.extractService.extractAndUpsert.mock.calls[0];
    // Kept tail only — earliest entries must NOT appear.
    expect(text).not.toContain('msg-0');
    expect(text).not.toContain('msg-5');
    // Most recent (msg-9) must appear.
    expect(text).toContain('msg-9');
  });

  test('runNow bypasses debounce and runs immediately', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 10_000, // long enough that a real timer wouldn't fire in this test
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
    });
    await env.coordinator.runNow('thread-1', DEFAULT_SOURCE);
    expect(env.extractService.extractAndUpsert).toHaveBeenCalledTimes(1);
  });

  test('cancel() removes a pending timer', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 40,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    env.coordinator.cancel('thread-1');
    await sleep(80);
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
  });

  test('is a no-op when MemoryExtractService is not registered in the container', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
      registerExtractService: false,
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    // No call should have happened — coordinator should have bailed silently.
    expect(env.extractService.extractAndUpsert).not.toHaveBeenCalled();
  });

  test('provider override on avatar.memoryExtraction takes precedence', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
      provider: 'groq-extract',
      taskProvider: 'doubao',
      avatarLlmProvider: 'openai',
      defaultProvider: 'deepseek',
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    const [, , options] = env.extractService.extractAndUpsert.mock.calls[0];
    expect(options.provider).toBe('groq-extract');
  });

  test('falls back to ai.taskProviders.memoryExtract when no avatar override', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
      taskProvider: 'doubao',
      avatarLlmProvider: 'openai',
      defaultProvider: 'deepseek',
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    const [, , options] = env.extractService.extractAndUpsert.mock.calls[0];
    expect(options.provider).toBe('doubao');
  });

  test('falls back to avatar.llmProvider when no taskProviders.memoryExtract', async () => {
    const env = setup({
      enabled: true,
      debounceMs: 20,
      minUserEntries: 1,
      entries: [makeEntry({ content: 'hi', isBotReply: false, userId: 'u-1' })],
      avatarLlmProvider: 'openai',
      defaultProvider: 'deepseek',
    });
    env.coordinator.schedule('thread-1', DEFAULT_SOURCE);
    await sleep(80);
    const [, , options] = env.extractService.extractAndUpsert.mock.calls[0];
    expect(options.provider).toBe('openai');
  });
});
