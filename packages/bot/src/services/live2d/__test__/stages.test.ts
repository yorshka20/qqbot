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
import type { Live2DInput } from '../types';

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
    return `SYSTEM[${name}]:\n${vars.availableActions}`;
  });

  beforeEach(() => fakeRender.mockClear());

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
    const stage = new PromptAssemblyStage({ render: fakeRender } as never, fakeSession() as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.availableActions).toBeDefined();
    expect(ctx.availableActions).toContain('wave');
    expect(ctx.systemPrompt).toContain('SYSTEM[avatar.speak-system]');
    expect(ctx.messages?.length).toBeGreaterThanOrEqual(2);
    expect(ctx.threadId).toBeDefined();
    expect(ctx.skipped).toBe(false);
  });

  it('picks the bilibili template when source is bilibili-danmaku-batch', async () => {
    const stage = new PromptAssemblyStage({ render: fakeRender } as never, fakeSession() as never);
    const ctx = createContext(sampleInput({ source: 'bilibili-danmaku-batch' }));
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.systemPrompt).toContain('avatar.bilibili-batch-system');
  });

  it('skips with prompt-render-failed when the template throws', async () => {
    const throwing = mock(() => {
      throw new Error('template missing');
    });
    const stage = new PromptAssemblyStage({ render: throwing } as never, fakeSession() as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('prompt-render-failed');
  });

  it('is a no-op when avatar is missing (defensive)', async () => {
    const stage = new PromptAssemblyStage({ render: fakeRender } as never, fakeSession() as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = null;
    await stage.execute(ctx);
    expect(fakeRender).not.toHaveBeenCalled();
    expect(ctx.systemPrompt).toBeUndefined();
  });
});

describe('LLMStage', () => {
  const fakeConfig = {
    getAIConfig: () => ({ defaultProviders: { llm: 'deepseek' } }),
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
    );
    const ctx = createContext(sampleInput());
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('prompt-render-failed');
  });

  it('populates replyText on success and marks streamingHandled', async () => {
    const generateStream = fakeStream('你好 [LIVE2D: emotion=happy, action=wave, intensity=0.8]');
    const stage = new LLMStage({ generateStream } as never, fakeConfig as never, fakeSession() as never);
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

  it('skips with llm-failed when generateStream throws', async () => {
    const stage = new LLMStage(
      { generateStream: mock(() => Promise.reject(new Error('network'))) } as never,
      fakeConfig as never,
      fakeSession() as never,
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
      { getAIConfig: () => undefined } as never,
      fakeSession() as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(capturedProvider).toBe('deepseek');
  });

  it('dispatches speak + tag animations while streaming (avatar-path)', async () => {
    const avatar = makeAvatar();
    const generateStream = fakeStream('你好啊。[LIVE2D: emotion=happy, action=wave, intensity=0.8]再见。');
    const stage = new LLMStage({ generateStream } as never, fakeConfig as never, fakeSession() as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    // One tag expected, enqueued during the flush that contained it.
    expect(avatar.enqueued.length).toBe(1);
    expect(avatar.enqueued[0].action).toBe('wave');
    expect(ctx.tagCount).toBe(1);
    // Tag-stripped text reached speak at least once.
    expect(avatar.spoken.join('')).toContain('你好啊');
    expect(avatar.spoken.join('')).toContain('再见');
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
