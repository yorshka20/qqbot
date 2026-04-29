// Stage-level unit tests. These exercise each stage in isolation against a
// hand-built context — no tsyringe container, no real avatar. The goal is
// to pin down each stage's contract (skip reasons, context mutations) so
// future enhancers can safely swap implementations.

import 'reflect-metadata';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createContext, type Live2DContext } from '../Live2DStage';
import { GateStage } from '../stages/GateStage';
import { LLMStage } from '../stages/LLMStage';
import { PromptAssemblyStage } from '../stages/PromptAssemblyStage';
import { SpeakStage } from '../stages/SpeakStage';
import { TagAnimationStage } from '../stages/TagAnimationStage';
import type { Live2DInput } from '@/integrations/avatar/types';

function sampleInput(overrides?: Partial<Live2DInput>): Live2DInput {
  return { text: 'hello', source: 'avatar-cmd', ...overrides };
}

interface ActionSummary {
  name: string;
  category?: string;
  description?: string;
}

interface FakeAvatar {
  active: boolean;
  consumer: boolean;
  actions: ActionSummary[];
  enqueued: Array<{ emotion: string; action: string; intensity: number; durationOverrideMs?: number }>;
  emotioned: Array<{ name: string; intensity: number }>;
  gazed: unknown[];
  spoken: string[];
  poses: string[];
  isActive(): boolean;
  hasConsumer(): boolean;
  listActions(): ActionSummary[];
  enqueueTagAnimation(t: { emotion: string; action: string; intensity: number; durationOverrideMs?: number }): void;
  enqueueEmotion(name: string, intensity: number): void;
  setGazeTarget(target: unknown): void;
  getActionDuration(action: string): number | undefined;
  speak(text: string): void;
  setActivity(p: { pose?: string }): void;
}

function makeAvatar(
  overrides: Partial<Pick<FakeAvatar, 'active' | 'consumer' | 'actions'>> & { actionDuration?: number } = {},
): FakeAvatar {
  return {
    active: overrides.active ?? true,
    consumer: overrides.consumer ?? true,
    actions: overrides.actions ?? [{ name: 'wave', category: 'movement' }],
    enqueued: [],
    emotioned: [],
    gazed: [],
    spoken: [],
    poses: [],
    isActive() {
      return this.active;
    },
    hasConsumer() {
      return this.consumer;
    },
    listActions() {
      return this.actions;
    },
    enqueueTagAnimation(t) {
      this.enqueued.push(t);
    },
    enqueueEmotion(name, intensity) {
      this.emotioned.push({ name, intensity });
    },
    setGazeTarget(target) {
      this.gazed.push(target);
    },
    getActionDuration(_action) {
      return overrides.actionDuration;
    },
    speak(text) {
      this.spoken.push(text);
    },
    setActivity(p) {
      if (p.pose) this.poses.push(p.pose);
    },
  };
}

describe('GateStage', () => {
  it('skips with avatar-inactive when the DI container has no AvatarService', async () => {
    // No avatar registered in DI → resolveAvatar() returns null.
    const stage = new GateStage();
    const ctx = createContext(sampleInput());
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('avatar-inactive');
    expect(ctx.avatar).toBeNull();
  });

  it('skips with no-consumer when avatar is active but nobody watches', async () => {
    const avatar = makeAvatar({ active: true, consumer: false });
    // Bypass the real resolveAvatar by subclassing — we want to test the
    // gate logic independently of the DI container.
    class TestableGate extends GateStage {
      override async execute(ctx: Live2DContext): Promise<void> {
        ctx.avatar = avatar as unknown as Live2DContext['avatar'];
        if (!avatar.isActive()) {
          ctx.skipped = true;
          ctx.skipReason = 'avatar-inactive';
          return;
        }
        if (!avatar.hasConsumer()) {
          ctx.skipped = true;
          ctx.skipReason = 'no-consumer';
        }
      }
    }
    const ctx = createContext(sampleInput());
    await new TestableGate().execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('no-consumer');
  });
});

describe('PromptAssemblyStage', () => {
  const fakeRender = mock((name: string, vars: Record<string, string>) => {
    return `SYSTEM[${name}]:\n${vars.availableActions ?? ''}`;
  });
  /**
   * Mimics `PromptManager.renderBaseSystemTemplate`: injects currentDate
   * alongside caller-supplied vars. Tests can assert the marker appears
   * in the rendered base system to prove the injection is wired.
   */
  const fakeRenderBase = mock((name: string, overrides?: Record<string, string>): string | undefined => {
    const vars: Record<string, string> = { currentDate: '2026-01-01', ...(overrides ?? {}) };
    return `SYSTEM[${name}]:\n${vars.availableActions ?? ''}\ncurrentDate=${vars.currentDate}`;
  });
  beforeEach(() => {
    fakeRender.mockClear();
    fakeRenderBase.mockClear();
  });

  function fakePrompt() {
    return { render: fakeRender, renderBaseSystemTemplate: fakeRenderBase };
  }

  function fakeSession() {
    let i = 0;
    return {
      ensureThread: mock(() => `t-${++i}`),
      getHistoryEntries: mock(() => []),
      appendUserMessage: mock(() => undefined),
      appendAssistantMessage: mock(() => undefined),
      scheduleCompression: mock(() => undefined),
    };
  }

  it('populates availableActions + systemPrompt on the happy path', async () => {
    const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.availableActions).toBeDefined();
    expect(ctx.availableActions).toContain('wave');
    // systemPrompt is base + scene joined; both templates should be rendered.
    expect(ctx.systemPrompt).toContain('SYSTEM[avatar.base.system]');
    expect(ctx.systemPrompt).toContain('SYSTEM[avatar.scenes.avatar-cmd]');
    // Base system must carry the date injection (same contract as main pipeline).
    expect(ctx.systemPrompt).toContain('currentDate=2026-01-01');
    expect(ctx.messages?.length).toBeGreaterThanOrEqual(3);
    expect(ctx.threadId).toBeDefined();
    expect(ctx.skipped).toBe(false);
  });

  it('picks the bilibili template when source is bilibili-danmaku-batch', async () => {
    const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
    const ctx = createContext(sampleInput({ source: 'bilibili-danmaku-batch' }));
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.systemPrompt).toContain('avatar.scenes.bilibili-batch');
  });

  it('skips with prompt-render-failed when the template throws', async () => {
    const throwing = mock(() => {
      throw new Error('template missing');
    });
    const stage = new PromptAssemblyStage(
      { render: throwing, renderBaseSystemTemplate: throwing } as never,
      fakeSession() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('prompt-render-failed');
  });

  it('is a no-op when avatar is missing (defensive)', async () => {
    const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = null;
    await stage.execute(ctx);
    expect(fakeRender).not.toHaveBeenCalled();
    expect(fakeRenderBase).not.toHaveBeenCalled();
    expect(ctx.systemPrompt).toBeUndefined();
  });

  // ── Memory context fan-out ──────────────────────────────────────────
  // These tests register a fake MemoryService in the global DI container
  // so `resolveMemoryContext` can exercise its real read path. We check
  // both the main-pipeline-compatible single-speaker case and the
  // multi-speaker bilibili batch case.
  describe('memory context fan-out', () => {
    function fakeMemoryService(overrides?: {
      hasUserMemoryFor?: Set<string>;
      groupText?: string;
      userTextByUid?: Record<string, string>;
    }) {
      const allow = overrides?.hasUserMemoryFor;
      const userTextByUid = overrides?.userTextByUid ?? {};
      return {
        hasUserMemory: mock((_groupId: string, uid: string) => {
          if (!allow) return true;
          return allow.has(uid);
        }),
        // Signature-compatible with the real getFilteredMemoryForReplyAsync.
        // Group memory is returned on the `_global_memory_` lookup; per-user
        // memory on any other uid.
        getFilteredMemoryForReplyAsync: mock(
          async (_groupId: string, userId: string | undefined, _opts?: { userMessage?: string }) => {
            const isGroup = !userId || userId === '_global_memory_';
            return {
              groupMemoryText: isGroup ? (overrides?.groupText ?? '') : '',
              userMemoryText: isGroup ? '' : (userTextByUid[userId] ?? ''),
              stats: { groupIncluded: 0, groupTotal: 0, userIncluded: 0, userTotal: 0 },
            };
          },
        ),
      };
    }

    it('renders a single-speaker block for single-sender sources (livemode-style)', async () => {
      const memorySvc = fakeMemoryService({
        groupText: '[rule]\n不透剧',
        userTextByUid: { '42': '[preference:game]\n喜欢崩铁' },
      });
      const { getContainer } = await import('@/core/DIContainer');
      const { DITokens } = await import('@/core/DITokens');
      getContainer().registerInstance(DITokens.MEMORY_SERVICE, memorySvc, { allowOverride: true });

      const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
      const ctx = createContext(
        sampleInput({
          source: 'livemode-private-batch',
          sender: { uid: '42', name: '张三' },
        }),
      );
      ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
      await stage.execute(ctx);

      const finalTurn = ctx.messages?.[ctx.messages.length - 1]?.content as string;
      expect(finalTurn).toContain('<memory_context>');
      expect(finalTurn).toContain('## 关于本群的记忆');
      expect(finalTurn).toContain('## 关于用户的记忆');
      expect(finalTurn).toContain('### [speaker:42:张三]');
      expect(finalTurn).toContain('[preference:game]');
    });

    it('fans out per-user lookups for bilibili batches (meta.senders) with distinct speaker sections', async () => {
      const memorySvc = fakeMemoryService({
        groupText: '[rule]\n不透剧',
        userTextByUid: {
          '111': '[preference:game]\n喜欢崩铁',
          '222': '[history]\n第一次来',
        },
      });
      const { getContainer } = await import('@/core/DIContainer');
      const { DITokens } = await import('@/core/DITokens');
      getContainer().registerInstance(DITokens.MEMORY_SERVICE, memorySvc, { allowOverride: true });

      const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
      const ctx = createContext(
        sampleInput({
          source: 'bilibili-danmaku-batch',
          meta: {
            senders: [
              { uid: '111', name: '米哈游工作室', text: '主播开播啦' },
              { uid: '222', name: '路人A', text: '666' },
            ],
          },
        }),
      );
      ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
      await stage.execute(ctx);

      const finalTurn = ctx.messages?.[ctx.messages.length - 1]?.content as string;
      expect(finalTurn).toContain('### [speaker:111:米哈游工作室]');
      expect(finalTurn).toContain('### [speaker:222:路人A]');
      // Per-user queryText is each speaker's own line, not the batch-wide text.
      const calls = memorySvc.getFilteredMemoryForReplyAsync.mock.calls;
      const userCalls = calls.filter((c) => c[0] && c[1] && c[1] !== '_global_memory_');
      const userMsgs = userCalls.map((c) => c[2]?.userMessage);
      expect(userMsgs).toContain('主播开播啦');
      expect(userMsgs).toContain('666');
    });

    it('skips per-user lookup for uids with no memory on disk (hasUserMemory gate)', async () => {
      const memorySvc = fakeMemoryService({
        groupText: '',
        hasUserMemoryFor: new Set(['111']), // 222 gets filtered out
        userTextByUid: { '111': '[p]\nA' },
      });
      const { getContainer } = await import('@/core/DIContainer');
      const { DITokens } = await import('@/core/DITokens');
      getContainer().registerInstance(DITokens.MEMORY_SERVICE, memorySvc, { allowOverride: true });

      const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
      const ctx = createContext(
        sampleInput({
          source: 'bilibili-danmaku-batch',
          meta: {
            senders: [
              { uid: '111', name: 'Alice', text: 'a' },
              { uid: '222', name: 'Bob', text: 'b' },
            ],
          },
        }),
      );
      ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
      await stage.execute(ctx);

      const calls = memorySvc.getFilteredMemoryForReplyAsync.mock.calls;
      const uidsQueried = calls.map((c) => c[1]).filter((u): u is string => !!u && u !== '_global_memory_');
      expect(uidsQueried).toContain('111');
      expect(uidsQueried).not.toContain('222');
      const finalTurn = ctx.messages?.[ctx.messages.length - 1]?.content as string;
      expect(finalTurn).toContain('### [speaker:111:Alice]');
      expect(finalTurn).not.toContain('Bob');
    });

    it('emits no <memory_context> wrapper when everything is empty (avatar-cmd, no sender, no group memory)', async () => {
      const memorySvc = fakeMemoryService({ groupText: '', userTextByUid: {} });
      const { getContainer } = await import('@/core/DIContainer');
      const { DITokens } = await import('@/core/DITokens');
      getContainer().registerInstance(DITokens.MEMORY_SERVICE, memorySvc, { allowOverride: true });

      const stage = new PromptAssemblyStage(fakePrompt() as never, fakeSession() as never);
      const ctx = createContext(sampleInput({ source: 'avatar-cmd' })); // no sender, no senders meta
      ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
      await stage.execute(ctx);

      const finalTurn = ctx.messages?.[ctx.messages.length - 1]?.content as string;
      expect(finalTurn).not.toContain('<memory_context>');
      // Per-user lookups must not have fired — there was no sender to begin with.
      const calls = memorySvc.getFilteredMemoryForReplyAsync.mock.calls;
      const userCalls = calls.filter((c) => c[1] && c[1] !== '_global_memory_');
      expect(userCalls.length).toBe(0);
    });
  });
});

describe('LLMStage', () => {
  const fakeConfig = {
    getAIConfig: () => ({ defaultProviders: { llm: 'deepseek' } }),
    /** Default non-stream in production; tests use streaming unless overridden. */
    getAvatarConfig: () => ({ llmStream: true }),
  };

  function fakeSession() {
    let i = 0;
    return {
      ensureThread: mock(() => `t-${++i}`),
      getHistoryEntries: mock(() => []),
      appendUserMessage: mock(() => undefined),
      appendAssistantMessage: mock(() => undefined),
      scheduleCompression: mock(() => undefined),
    };
  }

  /**
   * Fake memory-extraction coordinator — LLMStage calls `.schedule(threadId)`
   * on every successful reply. The real coordinator debounces; the fake just
   * records calls so tests can assert the wiring without exercising timers.
   */
  function fakeMemoryCoordinator() {
    return {
      schedule: mock((_threadId: string) => undefined),
      cancel: mock(() => undefined),
      cancelAll: mock(() => undefined),
      runNow: mock(async () => undefined),
    };
  }

  /**
   * Builds a fake generateStream that emits the given text as a single chunk
   * (tests don't need true chunking — SentenceFlusher is tested elsewhere via
   * its own unit tests). Signature matches LLMService.generateStream.
   */
  function fakeStream(text: string) {
    return mock(async (_prompt: string, handler: (chunk: string) => void) => {
      handler(text);
      return { text };
    });
  }

  it('skips with prompt-render-failed when systemPrompt is missing', async () => {
    const stage = new LLMStage(
      { generateStream: fakeStream('') } as never,
      fakeConfig as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const ctx = createContext(sampleInput());
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('prompt-render-failed');
  });

  it('populates replyText on success and marks streamingHandled', async () => {
    const generateStream = fakeStream('你好 [LIVE2D: emotion=happy, action=wave, intensity=0.8]');
    const stage = new LLMStage(
      { generateStream } as never,
      fakeConfig as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const avatar = makeAvatar();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(ctx.replyText).toContain('你好');
    expect(ctx.skipped).toBe(false);
    expect(ctx.streamingHandled).toBe(true);
    expect(generateStream).toHaveBeenCalledTimes(1);
  });

  it('schedules a memory-extraction run after a successful reply (threadId + source)', async () => {
    const generateStream = fakeStream('你好');
    const memoryCoordinator = fakeMemoryCoordinator();
    const stage = new LLMStage(
      { generateStream } as never,
      fakeConfig as never,
      fakeSession() as never,
      memoryCoordinator as never,
    );
    // Use a real Bilibili input so the test matches the default allowlist —
    // the coordinator itself enforces the allowlist in its own test file; here
    // we just verify LLMStage wires the source through.
    const ctx = createContext(sampleInput({ source: 'bilibili-danmaku-batch' }));
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    ctx.systemPrompt = 'sys';
    ctx.threadId = 'thread-42';
    await stage.execute(ctx);
    expect(memoryCoordinator.schedule).toHaveBeenCalledTimes(1);
    expect(memoryCoordinator.schedule).toHaveBeenCalledWith('thread-42', 'bilibili-danmaku-batch');
  });

  it('still forwards /avatar-cmd source to the coordinator (filtering happens there)', async () => {
    const generateStream = fakeStream('你好');
    const memoryCoordinator = fakeMemoryCoordinator();
    const stage = new LLMStage(
      { generateStream } as never,
      fakeConfig as never,
      fakeSession() as never,
      memoryCoordinator as never,
    );
    const ctx = createContext(sampleInput({ source: 'avatar-cmd' }));
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    ctx.systemPrompt = 'sys';
    ctx.threadId = 'thread-42';
    await stage.execute(ctx);
    // LLMStage always forwards — source filtering is the coordinator's job.
    // This keeps the stage's responsibility narrow + tests the wiring.
    expect(memoryCoordinator.schedule).toHaveBeenCalledWith('thread-42', 'avatar-cmd');
  });

  it('does NOT schedule memory-extraction when the reply path is skipped', async () => {
    const generateStream = fakeStream('   ');
    const memoryCoordinator = fakeMemoryCoordinator();
    const stage = new LLMStage(
      { generateStream } as never,
      fakeConfig as never,
      fakeSession() as never,
      memoryCoordinator as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    ctx.threadId = 'thread-42';
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(memoryCoordinator.schedule).not.toHaveBeenCalled();
  });

  it('skips with llm-failed when generateStream throws', async () => {
    const stage = new LLMStage(
      { generateStream: mock(() => Promise.reject(new Error('network'))) } as never,
      fakeConfig as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('llm-failed');
  });

  it('skips with empty-reply when stream yields empty text', async () => {
    const stage = new LLMStage(
      { generateStream: fakeStream('   ') } as never,
      fakeConfig as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('empty-reply');
  });

  it('falls back to deepseek when no default provider configured', async () => {
    let capturedProvider: string | undefined;
    const generateStream = mock(
      async (_prompt: string, handler: (chunk: string) => void, _opts: unknown, provider: string) => {
        capturedProvider = provider;
        handler('ok');
        return { text: 'ok' };
      },
    );
    const stage = new LLMStage(
      { generateStream } as never,
      { getAIConfig: () => undefined, getAvatarConfig: () => ({ llmStream: true }) } as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(capturedProvider).toBe('deepseek');
  });

  it('dispatches speak + tag animations while streaming (avatar-path)', async () => {
    const avatar = makeAvatar();
    const generateStream = fakeStream('你好啊。[LIVE2D: emotion=happy, action=wave, intensity=0.8]再见。');
    const stage = new LLMStage(
      { generateStream } as never,
      fakeConfig as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    // One tag expected, enqueued during the flush that contained it.
    expect(avatar.enqueued.length).toBe(1);
    expect(avatar.enqueued[0].action).toBe('wave');
    expect(ctx.tagCount).toBe(2);
    // Tag-stripped text reached speak at least once.
    expect(avatar.spoken.join('')).toContain('你好啊');
    expect(avatar.spoken.join('')).toContain('再见');
  });

  it('uses generate (non-stream) when avatar.llmStream is false and meta does not override', async () => {
    const text = '你好 [LIVE2D: emotion=happy, action=wave, intensity=0.8]';
    const generate = mock(async () => ({ text }));
    const generateStream = mock(async () => {
      throw new Error('should not be called');
    });
    const stage = new LLMStage(
      { generate, generateStream } as never,
      {
        getAIConfig: () => ({ defaultProviders: { llm: 'deepseek' } }),
        getAvatarConfig: () => ({ llmStream: false }),
      } as never,
      fakeSession() as never,
      fakeMemoryCoordinator() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateStream).not.toHaveBeenCalled();
    expect(ctx.replyText).toContain('你好');
    expect(ctx.streamingHandled).toBe(true);
  });
});

describe('TagAnimationStage', () => {
  it('parses and enqueues each tag from replyText (legacy format)', async () => {
    const avatar = makeAvatar();
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '你好 [LIVE2D: emotion=happy, action=wave, intensity=0.8]';
    await stage.execute(ctx);
    // Legacy tag produces 2 ParsedTags: action + derived emotion.
    expect(avatar.enqueued.length).toBe(1);
    expect(avatar.enqueued[0].action).toBe('wave');
    expect(avatar.emotioned.length).toBe(1);
    expect(avatar.emotioned[0].name).toBe('happy');
    expect(ctx.tagCount).toBe(2);
  });

  it('is a no-op when replyText is missing', async () => {
    const avatar = makeAvatar();
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(avatar.enqueued.length).toBe(0);
    expect(ctx.tagCount).toBeUndefined();
  });

  it('does NOT set skipped even if no tags were present', async () => {
    const avatar = makeAvatar();
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = 'plain text without tags';
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(false);
    expect(ctx.tagCount).toBe(0);
  });
});

describe('TagAnimationStage — rich tag routing', () => {
  it('routes [E:], [G:], [H:]+[A:] to the correct AvatarService methods', async () => {
    // getActionDuration returns 1000 so hold multiplier 0.8 → override 800ms.
    const avatar = makeAvatar({ actionDuration: 1000 });
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '[E:happy@0.7] hi [G:camera] [H:short][A:nod]';
    await stage.execute(ctx);

    expect(avatar.emotioned).toHaveLength(1);
    expect(avatar.emotioned[0].name).toBe('happy');
    expect(avatar.emotioned[0].intensity).toBeCloseTo(0.7);

    expect(avatar.gazed).toHaveLength(1);
    expect((avatar.gazed[0] as { type: string; name: string }).type).toBe('named');
    expect((avatar.gazed[0] as { type: string; name: string }).name).toBe('camera');

    expect(avatar.enqueued).toHaveLength(1);
    expect(avatar.enqueued[0].action).toBe('nod');
    expect(avatar.enqueued[0].emotion).toBe('neutral');
    expect(avatar.enqueued[0].intensity).toBeCloseTo(1.0);
    // 1000ms * 0.8 (short) = 800ms
    expect(avatar.enqueued[0].durationOverrideMs).toBe(800);

    expect(ctx.tagCount).toBe(4);
    expect(ctx.pendingHoldMultiplier).toBeUndefined();
  });

  it('drops an unconsumed hold when no following action tag', async () => {
    const avatar = makeAvatar();
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '[H:long]';
    await stage.execute(ctx);

    expect(avatar.enqueued).toHaveLength(0);
    expect(avatar.emotioned).toHaveLength(0);
    expect(avatar.gazed).toHaveLength(0);
    expect(ctx.tagCount).toBe(1);
    expect(ctx.pendingHoldMultiplier).toBeUndefined();
  });

  it('legacy regression: [LIVE2D:] produces action + derived emotion baseline', async () => {
    const avatar = makeAvatar();
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '[LIVE2D: action=wave, emotion=happy, intensity=0.8]';
    await stage.execute(ctx);

    expect(avatar.enqueued).toHaveLength(1);
    expect(avatar.enqueued[0].action).toBe('wave');
    expect(avatar.enqueued[0].emotion).toBe('happy');
    expect(avatar.enqueued[0].intensity).toBeCloseTo(0.8);
    expect(avatar.enqueued[0].durationOverrideMs).toBeUndefined();

    expect(avatar.emotioned).toHaveLength(1);
    expect(avatar.emotioned[0].name).toBe('happy');

    expect(ctx.tagCount).toBe(2);
  });

  it('short-circuits when streamingHandled is true', async () => {
    const avatar = makeAvatar({ actionDuration: 1000 });
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '[E:happy@0.9][A:wave]';
    ctx.streamingHandled = true;
    await stage.execute(ctx);

    expect(avatar.enqueued).toHaveLength(0);
    expect(avatar.emotioned).toHaveLength(0);
    expect(avatar.gazed).toHaveLength(0);
    expect(ctx.tagCount).toBeUndefined();
  });
});

describe('SpeakStage', () => {
  it('strips tags and calls avatar.speak with the remainder', async () => {
    const avatar = makeAvatar();
    const stage = new SpeakStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '你好啊 [LIVE2D: emotion=happy, action=wave, intensity=0.8]';
    await stage.execute(ctx);
    expect(ctx.spoken).toBe('你好啊');
    expect(avatar.spoken).toEqual(['你好啊']);
  });

  it('does not call speak when stripped text is empty', async () => {
    const avatar = makeAvatar();
    const stage = new SpeakStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '[LIVE2D: emotion=neutral, action=nod, intensity=0.5]';
    await stage.execute(ctx);
    expect(avatar.spoken).toEqual([]);
  });

  it('is a no-op when replyText is missing', async () => {
    const avatar = makeAvatar();
    const stage = new SpeakStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(avatar.spoken.length).toBe(0);
  });
});
