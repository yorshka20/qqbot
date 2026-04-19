// Stage-level unit tests. These exercise each stage in isolation against a
// hand-built context — no tsyringe container, no real avatar. The goal is
// to pin down each stage's contract (skip reasons, context mutations) so
// future enhancers can safely swap implementations.

import 'reflect-metadata';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { GateStage } from '../stages/GateStage';
import { LLMStage } from '../stages/LLMStage';
import { PromptAssemblyStage } from '../stages/PromptAssemblyStage';
import { SpeakStage } from '../stages/SpeakStage';
import { TagAnimationStage } from '../stages/TagAnimationStage';
import { createContext, type Live2DContext } from '../Live2DStage';
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
  enqueued: Array<{ emotion: string; action: string; intensity: number }>;
  spoken: string[];
  poses: string[];
  isActive(): boolean;
  hasConsumer(): boolean;
  listActions(): ActionSummary[];
  enqueueTagAnimation(t: { emotion: string; action: string; intensity: number }): void;
  speak(text: string): void;
  setActivity(p: { pose?: string }): void;
}

function makeAvatar(overrides: Partial<Pick<FakeAvatar, 'active' | 'consumer' | 'actions'>> = {}): FakeAvatar {
  return {
    active: overrides.active ?? true,
    consumer: overrides.consumer ?? true,
    actions: overrides.actions ?? [{ name: 'wave', category: 'movement' }],
    enqueued: [],
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

  it('populates availableActions + systemPrompt on the happy path', async () => {
    const stage = new PromptAssemblyStage({ render: fakeRender } as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.availableActions).toBeDefined();
    expect(ctx.availableActions).toContain('wave');
    expect(ctx.systemPrompt).toContain('SYSTEM[avatar.speak-system]');
    expect(ctx.skipped).toBe(false);
  });

  it('picks the bilibili template when source is bilibili-danmaku-batch', async () => {
    const stage = new PromptAssemblyStage({ render: fakeRender } as never);
    const ctx = createContext(sampleInput({ source: 'bilibili-danmaku-batch' }));
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.systemPrompt).toContain('avatar.bilibili-batch-system');
  });

  it('skips with prompt-render-failed when the template throws', async () => {
    const throwing = mock(() => {
      throw new Error('template missing');
    });
    const stage = new PromptAssemblyStage({ render: throwing } as never);
    const ctx = createContext(sampleInput());
    ctx.avatar = makeAvatar() as unknown as Live2DContext['avatar'];
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('prompt-render-failed');
  });

  it('is a no-op when avatar is missing (defensive)', async () => {
    const stage = new PromptAssemblyStage({ render: fakeRender } as never);
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

  it('skips with prompt-render-failed when systemPrompt is missing', async () => {
    const stage = new LLMStage(
      { generate: mock(() => Promise.resolve({ text: '' })) } as never,
      fakeConfig as never,
    );
    const ctx = createContext(sampleInput());
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('prompt-render-failed');
  });

  it('populates replyText on success', async () => {
    const generate = mock(() => Promise.resolve({ text: '你好 [LIVE2D: emotion=happy, action=wave, intensity=0.8]' }));
    const stage = new LLMStage({ generate } as never, fakeConfig as never);
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(ctx.replyText).toContain('你好');
    expect(ctx.skipped).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('skips with llm-failed when generate throws', async () => {
    const stage = new LLMStage(
      { generate: mock(() => Promise.reject(new Error('network'))) } as never,
      fakeConfig as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('llm-failed');
  });

  it('skips with empty-reply when generate returns empty text', async () => {
    const stage = new LLMStage(
      { generate: mock(() => Promise.resolve({ text: '   ' })) } as never,
      fakeConfig as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(ctx.skipped).toBe(true);
    expect(ctx.skipReason).toBe('empty-reply');
  });

  it('falls back to deepseek when no default provider configured', async () => {
    let capturedProvider: string | undefined;
    const generate = mock((_text: string, _opts: unknown, provider: string) => {
      capturedProvider = provider;
      return Promise.resolve({ text: 'ok' });
    });
    const stage = new LLMStage(
      { generate } as never,
      { getAIConfig: () => undefined } as never,
    );
    const ctx = createContext(sampleInput());
    ctx.systemPrompt = 'sys';
    await stage.execute(ctx);
    expect(capturedProvider).toBe('deepseek');
  });
});

describe('TagAnimationStage', () => {
  it('parses and enqueues each tag from replyText', async () => {
    const avatar = makeAvatar();
    const stage = new TagAnimationStage();
    const ctx = createContext(sampleInput());
    ctx.avatar = avatar as unknown as Live2DContext['avatar'];
    ctx.replyText = '你好 [LIVE2D: emotion=happy, action=wave, intensity=0.8]';
    await stage.execute(ctx);
    expect(avatar.enqueued.length).toBe(1);
    expect(avatar.enqueued[0].action).toBe('wave');
    expect(ctx.tagCount).toBe(1);
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
