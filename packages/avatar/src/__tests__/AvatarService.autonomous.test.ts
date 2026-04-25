import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { ResolvedAction } from '../compiler/types';
import type { MindModulation, MindModulationProvider } from '../mind/types';

/** Boot a real AvatarService with an in-process compiler (no VTS / preview). */
function service(): Promise<AvatarService> {
  const s = new AvatarService();
  return s
    .initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 60, outputFps: 60 },
    })
    .then(() => s);
}

/** Freeze jitter so modulation tests only observe deterministic math. */
function freezeJitter(s: AvatarService): void {
  const compiler = (s as any).compiler;
  compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
  compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
}

function withProvider(s: AvatarService, modulation: MindModulation): void {
  const provider: MindModulationProvider = { getModulation: () => modulation };
  s.setMindModulationProvider(provider);
}

// ─────────────────────────────────────────────────────────────────────────────
// enqueueAutonomous — normal path
// ─────────────────────────────────────────────────────────────────────────────

describe('AvatarService.enqueueAutonomous — normal path', () => {
  let s: AvatarService;

  beforeEach(async () => {
    s = await service();
    freezeJitter(s);
  });

  afterEach(async () => {
    await s.stop();
  });

  test('enqueues a node with source=autonomous', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.6);
    expect(spy).toHaveBeenCalledTimes(1);
    const node = (spy.mock.calls[0][0] as Array<Record<string, unknown>>)[0];
    expect(node.source).toBe('autonomous');
  });

  test('enqueues expected action name and intensity', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.7);
    const node = (spy.mock.calls[0][0] as Array<{ action: string; intensity: number }>)[0];
    expect(node.action).toBe('emotion_smile');
    expect(node.intensity).toBeCloseTo(0.7, 5);
  });

  test('uses registered action duration as base when no override supplied', () => {
    const compiler = (s as any).compiler;
    const registeredDuration = compiler.getActionDuration('emotion_smile') as number;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5);
    const node = (spy.mock.calls[0][0] as Array<{ duration: number }>)[0];
    expect(node.duration).toBe(registeredDuration);
  });

  test('durationOverrideMs replaces action-map default as jitter base', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5, { durationOverrideMs: 2500 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number }>)[0];
    expect(node.duration).toBe(2500);
  });

  test('opts.emotion is forwarded to the StateNode', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5, { emotion: 'happy' });
    const node = (spy.mock.calls[0][0] as Array<{ emotion: string }>)[0];
    expect(node.emotion).toBe('happy');
  });

  test('emotion defaults to "neutral" when opts.emotion is omitted', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5);
    const node = (spy.mock.calls[0][0] as Array<{ emotion: string }>)[0];
    expect(node.emotion).toBe('neutral');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueueAutonomous — edge / invalid inputs
// ─────────────────────────────────────────────────────────────────────────────

describe('AvatarService.enqueueAutonomous — edge cases', () => {
  test('no-op when compiler is null (not initialized)', () => {
    const s = new AvatarService();
    // compiler stays null — just ensure no throw and no enqueue
    expect(() => s.enqueueAutonomous('emotion_smile', 0.5)).not.toThrow();
  });

  test('unknown action falls back to 1500ms base duration', async () => {
    const s = await service();
    freezeJitter(s);
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    // 'totally_unknown_xyz' is not in the action-map so getActionDuration → undefined
    s.enqueueAutonomous('totally_unknown_xyz', 0.5);
    // enqueue is still called — the compiler handles the unknown action silently
    const node = (spy.mock.calls[0]?.[0] as Array<{ duration: number }> | undefined)?.[0];
    expect(node?.duration).toBe(1500);
    await s.stop();
  });

  test('intensity above 1 is clamped by modulation floor but not floored above input', async () => {
    // enqueueAutonomous passes raw intensity to _enqueueModulated which eventually
    // clamps to [intensityFloor, 1] after modulation. We just ensure no exception
    // and the clamped result is ≤ 1.
    const s = await service();
    freezeJitter(s);
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 2.0);
    const node = (spy.mock.calls[0][0] as Array<{ intensity: number }>)[0];
    expect(node.intensity).toBeLessThanOrEqual(1);
    await s.stop();
  });

  test('intensity below 0 is raised to intensityFloor', async () => {
    const s = await service();
    freezeJitter(s);
    const compiler = (s as any).compiler;
    // Zero the jitter intensityFloor so we can see the raw clamp behavior
    compiler.setTunableParam('compiler:jitter', 'intensityFloor', 0);
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', -0.5);
    const node = (spy.mock.calls[0][0] as Array<{ intensity: number }>)[0];
    // After modulation (identity) + clamping, intensity should be ≥ 0
    expect(node.intensity).toBeGreaterThanOrEqual(0);
    await s.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueueAutonomous — modulation pipeline (same as enqueueTagAnimation)
// ─────────────────────────────────────────────────────────────────────────────

describe('AvatarService.enqueueAutonomous — modulation pipeline', () => {
  let s: AvatarService;

  beforeEach(async () => {
    s = await service();
    freezeJitter(s);
  });

  afterEach(async () => {
    await s.stop();
  });

  test('speedScale=2 halves duration', () => {
    const compiler = (s as any).compiler;
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 2.0 },
    });
    const base = compiler.getActionDuration('emotion_smile') as number;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5);
    const node = (spy.mock.calls[0][0] as Array<{ duration: number }>)[0];
    expect(node.duration).toBe(Math.round(base / 2));
  });

  test('intensityScale=0.5 halves intensity', () => {
    const compiler = (s as any).compiler;
    withProvider(s, {
      amplitude: { intensityScale: 0.5 },
      timing: { speedScale: 1.0 },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.8);
    const node = (spy.mock.calls[0][0] as Array<{ intensity: number }>)[0];
    expect(node.intensity).toBeCloseTo(0.4, 5);
  });

  test('jitterScale=0 produces deterministic output across repeated calls', () => {
    const compiler = (s as any).compiler;
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 1.0, jitterScale: 0 },
    });
    const base = compiler.getActionDuration('emotion_smile') as number;
    const spy = spyOn(compiler, 'enqueue');
    for (let i = 0; i < 20; i++) {
      s.enqueueAutonomous('emotion_smile', 0.5);
    }
    for (const call of spy.mock.calls) {
      const node = (call[0] as Array<{ duration: number; intensity: number }>)[0];
      expect(node.duration).toBe(base);
      expect(node.intensity).toBe(0.5);
    }
  });

  test('source marker is autonomous even when modulation provider is set', () => {
    const compiler = (s as any).compiler;
    withProvider(s, {
      amplitude: { intensityScale: 0.8 },
      timing: { speedScale: 1.0 },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5);
    const node = (spy.mock.calls[0][0] as Array<Record<string, unknown>>)[0];
    expect(node.source).toBe('autonomous');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueueAutonomousEmotion
// ─────────────────────────────────────────────────────────────────────────────

describe('AvatarService.enqueueAutonomousEmotion', () => {
  /** Minimal mock compiler controlling resolveAction output. */
  function makeMockCompiler(resolved: ResolvedAction | null) {
    return {
      resolveAction: mock((_action: string, _emotion: string, _intensity: number) => resolved),
      seedChannelBaseline: mock((_entries: Array<{ channel: string; value: number }>) => {}),
      getActionDuration: mock(() => undefined),
      getEffectiveJitter: mock(() => ({ duration: 0, intensity: 0, intensityFloor: 0.1 })),
      enqueue: mock(() => {}),
      getLayer: mock(() => undefined),
    };
  }

  test('seeds emotion channels — same behavior as enqueueEmotion', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 0.6,
      targets: [
        { channel: 'mouth.smile', targetValue: 0.6, weight: 1 },
        { channel: 'head.yaw', targetValue: 0.3, weight: 1 },
        { channel: 'eye.smile.l', targetValue: 0.5, weight: 1 },
      ],
    };
    const s = new AvatarService();
    (s as any).compiler = makeMockCompiler(resolved);

    s.enqueueAutonomousEmotion('happy', 0.6);

    const compiler = (s as any).compiler;
    expect(compiler.resolveAction).toHaveBeenCalledTimes(1);
    expect(compiler.seedChannelBaseline).toHaveBeenCalledTimes(1);
    const seeded = compiler.seedChannelBaseline.mock.calls[0][0] as Array<{ channel: string }>;
    // head.yaw is not an emotion channel and must be filtered out
    expect(seeded.find((e) => e.channel === 'mouth.smile')).toBeDefined();
    expect(seeded.find((e) => e.channel === 'eye.smile.l')).toBeDefined();
    expect(seeded.find((e) => e.channel === 'head.yaw')).toBeUndefined();
  });

  test('no-op when compiler is null', () => {
    const s = new AvatarService();
    expect(() => s.enqueueAutonomousEmotion('happy', 0.5)).not.toThrow();
  });

  test('unknown emotion → no seedChannelBaseline call', () => {
    const s = new AvatarService();
    const compiler = makeMockCompiler(null);
    (s as any).compiler = compiler;

    s.enqueueAutonomousEmotion('unknown_xyz', 0.5);

    expect(compiler.seedChannelBaseline).not.toHaveBeenCalled();
  });

  test('intensity clamped to 0 when negative', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 0,
      targets: [{ channel: 'mouth.smile', targetValue: 0, weight: 1 }],
    };
    const s = new AvatarService();
    (s as any).compiler = makeMockCompiler(resolved);

    s.enqueueAutonomousEmotion('x', -0.5);

    const compiler = (s as any).compiler;
    expect(compiler.resolveAction.mock.calls[0][2]).toBe(0);
  });

  test('intensity clamped to 1 when above 1', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 1,
      targets: [{ channel: 'mouth.smile', targetValue: 1, weight: 1 }],
    };
    const s = new AvatarService();
    (s as any).compiler = makeMockCompiler(resolved);

    s.enqueueAutonomousEmotion('x', 2);

    const compiler = (s as any).compiler;
    expect(compiler.resolveAction.mock.calls[0][2]).toBe(1);
  });

  test('no emotion channels in result → seedChannelBaseline NOT called', () => {
    const resolved: ResolvedAction = {
      kind: 'envelope',
      duration: 800,
      intensity: 0.5,
      targets: [
        { channel: 'head.yaw', targetValue: 0.5, weight: 1 },
        { channel: 'body.lean', targetValue: 0.3, weight: 1 },
      ],
    };
    const s = new AvatarService();
    (s as any).compiler = makeMockCompiler(resolved);

    s.enqueueAutonomousEmotion('x', 0.5);

    const compiler = (s as any).compiler;
    expect(compiler.seedChannelBaseline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: enqueueTagAnimation source marker
// ─────────────────────────────────────────────────────────────────────────────

describe('enqueueTagAnimation regression — source marker', () => {
  let s: AvatarService;

  beforeEach(async () => {
    s = await service();
  });

  afterEach(async () => {
    await s.stop();
  });

  test('enqueueTagAnimation emits source=llm on the StateNode', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<Record<string, unknown>>)[0];
    expect(node.source).toBe('llm');
  });
});
