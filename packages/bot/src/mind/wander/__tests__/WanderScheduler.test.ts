import { describe, expect, test } from 'bun:test';
import { DEFAULT_MIND_CONFIG, type MindConfig } from '../../types';
import { pickIntent } from '../intents';
import type { WanderExecutor, WanderIntentKind } from '../types';
import { WanderScheduler } from '../WanderScheduler';

// ─── Test doubles ────────────────────────────────────────────────────

interface FakeAvatar extends WanderExecutor {
  calls: Array<
    | { kind: 'walkForward'; meters: number }
    | { kind: 'strafe'; meters: number }
    | { kind: 'turn'; radians: number }
    | { kind: 'setGaze'; target: unknown }
    | { kind: 'setHead'; target: unknown }
  >;
  pose: string;
  active: boolean;
}

function fakeAvatar(init: Partial<Pick<FakeAvatar, 'pose' | 'active'>> = {}): FakeAvatar {
  const calls: FakeAvatar['calls'] = [];
  return {
    calls,
    pose: init.pose ?? 'neutral',
    active: init.active ?? true,
    getCurrentPose() {
      return this.pose;
    },
    isAvatarActive() {
      return this.active;
    },
    async walkForward(meters) {
      calls.push({ kind: 'walkForward', meters });
    },
    async strafe(meters) {
      calls.push({ kind: 'strafe', meters });
    },
    async turn(radians) {
      calls.push({ kind: 'turn', radians });
    },
    setGazeTarget(target) {
      calls.push({ kind: 'setGaze', target });
    },
    setHeadLook(target) {
      calls.push({ kind: 'setHead', target });
    },
  };
}

function seededRng(...values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

const wanderConfig = (overrides: Partial<MindConfig['wander']> = {}): MindConfig['wander'] => ({
  ...DEFAULT_MIND_CONFIG.wander,
  ...overrides,
});

// ─── pickIntent ──────────────────────────────────────────────────────

describe('pickIntent — weighted kind selection', () => {
  test('picks the only non-zero weight kind reliably', () => {
    const config = wanderConfig({
      intents: { glance: 1, look_around: 0, shift_weight: 0, micro_step: 0, browse: 0 },
    });
    const intent = pickIntent(config, () => 0.42);
    expect(intent.label).toBe('glance');
  });

  test('falls back to glance when all weights are zero', () => {
    const config = wanderConfig({
      intents: { glance: 0, look_around: 0, shift_weight: 0, micro_step: 0, browse: 0 },
    });
    const intent = pickIntent(config, () => 0.1);
    expect(intent.label).toBe('glance');
  });

  test('samples proportionally across many trials', () => {
    const config = wanderConfig({
      intents: { glance: 1, look_around: 1, shift_weight: 0, micro_step: 0, browse: 0 },
    });
    const counts: Record<WanderIntentKind, number> = {
      glance: 0,
      look_around: 0,
      shift_weight: 0,
      micro_step: 0,
      browse: 0,
    };
    for (let i = 0; i < 400; i++) counts[pickIntent(config).label]++;
    expect(counts.glance).toBeGreaterThan(100);
    expect(counts.look_around).toBeGreaterThan(100);
    expect(counts.shift_weight).toBe(0);
  });
});

describe('pickIntent — step shape per kind', () => {
  test('glance with head-still target emits setGaze → wait → clear', () => {
    const config = wanderConfig({ intents: { ...DEFAULT_MIND_CONFIG.wander.intents, glance: 1 } });
    // rng[1]=0 picks index 0 (camera, headYawFraction=0) so no head turn is added
    const intent = pickIntent(config, seededRng(0.01, 0, 0.3));
    expect(intent.steps.map((s) => s.kind)).toEqual(['setGaze', 'wait', 'setGaze']);
    expect(intent.steps[2]).toEqual({ kind: 'setGaze', target: { type: 'clear' } });
  });

  test('glance to left/right couples a head-only rotation with the gaze', () => {
    const config = wanderConfig({ intents: { ...DEFAULT_MIND_CONFIG.wander.intents, glance: 1 } });
    // rng[1]=0.5 picks index 2 (right), which has a non-zero head yaw
    const intent = pickIntent(config, seededRng(0.01, 0.5, 0.3));
    expect(intent.steps.map((s) => s.kind)).toEqual(['setHead', 'setGaze', 'wait', 'setGaze', 'setHead']);
    const heads = intent.steps.filter((s) => s.kind === 'setHead') as Array<{
      kind: 'setHead';
      target: { yaw?: number; pitch?: number } | null;
    }>;
    // First setHead sets a non-zero yaw, last releases the override.
    expect(heads[0].target?.yaw).not.toBe(0);
    expect(heads[1].target).toBeNull();
  });

  test('look_around produces head-only sweep (setHead → wait → setHead → wait → release)', () => {
    const config = wanderConfig({
      intents: { ...DEFAULT_MIND_CONFIG.wander.intents, glance: 0, look_around: 1 },
    });
    const intent = pickIntent(config, seededRng(0.01, 0.6, 0.5, 0.3, 0.4));
    expect(intent.steps.map((s) => s.kind)).toEqual(['setHead', 'wait', 'setHead', 'wait', 'setHead']);
    const heads = intent.steps.filter((s) => s.kind === 'setHead') as Array<{
      kind: 'setHead';
      target: { yaw?: number } | null;
    }>;
    // First two head targets have opposite yaw sign (out then back-past-centre); last
    // releases the override entirely.
    expect(Math.sign(heads[0].target?.yaw ?? 0)).not.toBe(Math.sign(heads[1].target?.yaw ?? 0));
    expect(heads[2].target).toBeNull();
  });

  test('micro_step forward then back', () => {
    // All weights zero except micro_step so the first rng call lands on micro_step
    // regardless of magnitude (weighted-random sums the only non-zero entry).
    const config = wanderConfig({
      intents: { glance: 0, look_around: 0, shift_weight: 0, micro_step: 1, browse: 0 },
    });
    const intent = pickIntent(config, seededRng(0.05, 0.7, 0.5));
    const walks = intent.steps.filter((s) => s.kind === 'walkForward') as Array<{
      kind: 'walkForward';
      meters: number;
    }>;
    expect(walks).toHaveLength(2);
    expect(walks[0].meters).toBeCloseTo(-walks[1].meters, 6);
  });

  test('amplitude caps bound generated magnitudes', () => {
    const config = wanderConfig({
      intents: { ...DEFAULT_MIND_CONFIG.wander.intents, glance: 0, look_around: 1 },
      amplitude: { maxTurnRad: 0.5, maxStepMeters: 0.2, maxStrafeMeters: 0.15 },
    });
    // rng=1 pushes every factor to its ceiling
    const intent = pickIntent(config, seededRng(0.1, 0.999, 0.999, 0.999));
    const turns = intent.steps.filter((s) => s.kind === 'turn') as Array<{ radians: number }>;
    for (const t of turns) expect(Math.abs(t.radians)).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});

// ─── WanderScheduler gate ───────────────────────────────────────────

describe('WanderScheduler — gate predicate', () => {
  test('non-neutral pose suppresses wander', async () => {
    const avatar = fakeAvatar({ pose: 'speaking' });
    const scheduler = new WanderScheduler(wanderConfig(), avatar, { sleep: async () => {} });
    scheduler.start();
    const intent = await scheduler.tickOnce();
    expect(intent).toBeNull();
    expect(avatar.calls).toHaveLength(0);
    scheduler.stop();
  });

  test('inactive avatar suppresses wander', async () => {
    const avatar = fakeAvatar({ active: false });
    const scheduler = new WanderScheduler(wanderConfig(), avatar, { sleep: async () => {} });
    scheduler.start();
    expect(await scheduler.tickOnce()).toBeNull();
    scheduler.stop();
  });

  test('disabled config refuses to start', async () => {
    const avatar = fakeAvatar();
    const scheduler = new WanderScheduler(wanderConfig({ enabled: false }), avatar);
    scheduler.start();
    expect(await scheduler.tickOnce()).toBeNull();
    scheduler.stop();
  });

  test('neutral pose + active avatar + started scheduler fires intent', async () => {
    const avatar = fakeAvatar();
    const scheduler = new WanderScheduler(
      wanderConfig({
        intents: { glance: 1, look_around: 0, shift_weight: 0, micro_step: 0, browse: 0 },
      }),
      avatar,
      { sleep: async () => {}, rng: () => 0.2 },
    );
    scheduler.start();
    const intent = await scheduler.tickOnce();
    expect(intent?.label).toBe('glance');
    // setGaze + setGaze (clear) — wait steps don't hit avatar
    expect(avatar.calls.filter((c) => c.kind === 'setGaze')).toHaveLength(2);
    scheduler.stop();
  });
});

// ─── WanderScheduler — cooldown ──────────────────────────────────────

describe('WanderScheduler — cooldown', () => {
  test('second tick within cooldown is gated out', async () => {
    const avatar = fakeAvatar();
    let nowMs = 10_000;
    const scheduler = new WanderScheduler(wanderConfig({ cooldownMs: 5_000 }), avatar, {
      sleep: async () => {},
      now: () => nowMs,
    });
    scheduler.start();
    await scheduler.tickOnce(); // first fires
    // Immediately after, still in cooldown:
    nowMs += 1_000;
    expect(await scheduler.tickOnce()).toBeNull();
    // Past cooldown:
    nowMs += 5_000;
    expect(await scheduler.tickOnce()).not.toBeNull();
    scheduler.stop();
  });
});

// ─── Execution error-swallow ────────────────────────────────────────

describe('WanderScheduler — error swallow', () => {
  test('motion rejection does not prevent subsequent steps', async () => {
    const avatar = fakeAvatar();
    avatar.turn = async () => {
      throw Object.assign(new Error('interrupted'), { name: 'WalkInterruptedError' });
    };
    const scheduler = new WanderScheduler(
      wanderConfig({ intents: { glance: 0, look_around: 1, shift_weight: 0, micro_step: 0, browse: 0 } }),
      avatar,
      { sleep: async () => {} },
    );
    scheduler.start();
    // Should not throw despite turn() rejecting.
    const intent = await scheduler.tickOnce();
    expect(intent?.label).toBe('look_around');
    scheduler.stop();
  });
});
