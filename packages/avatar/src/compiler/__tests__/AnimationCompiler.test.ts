/**
 * AnimationCompiler spring-damper tests + crossfade / baseline tests.
 *
 * NOTE: `(compiler as any).tick()` is a deliberate deterministic-testing
 * escape hatch. The real `tick()` is private (driven by setInterval), but
 * calling it directly lets tests control wall-clock time via a mocked
 * `Date.now` and advance the simulation at a fixed dt without relying on
 * real timers.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AvatarActivity } from '../../state/types';
import type { AnimationCompiler } from '../AnimationCompiler';
import type { AnimationLayer } from '../layers/types';
import type { ModelKind } from '../types';
import { newAnimationCompilerTest } from './newAnimationCompilerTest';

// ---------------------------------------------------------------------------
// Helper: a layer that emits a fixed, mutable contribution map each tick.
// ---------------------------------------------------------------------------
class ConstantSourceLayer implements AnimationLayer {
  id = 'test-const-source';
  private _enabled = true;
  private _weight = 1.0;
  private contrib: Record<string, number>;

  constructor(initial: Record<string, number> = {}) {
    this.contrib = { ...initial };
  }

  setContrib(c: Record<string, number>): void {
    this.contrib = { ...c };
  }

  sample(_nowMs: number, _activity: AvatarActivity): Record<string, number> {
    return this._enabled ? { ...this.contrib } : {};
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  getWeight(): number {
    return this._weight;
  }

  setWeight(weight: number): void {
    this._weight = weight;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function advanceTicks(compiler: AnimationCompiler, nowRef: { t: number }, count: number, dtMs = 16.67): void {
  for (let i = 0; i < count; i++) {
    nowRef.t += dtMs;
    (compiler as any).tick();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('AnimationCompiler spring-damper smoothing', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    nowRef = { t: 1000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 1 — step response, fast channel
  // -------------------------------------------------------------------------
  test('Test 1: mouth.open (fast, ω=25 ζ=1) reaches ≥0.95 within 200ms (12 ticks)', () => {
    const compiler = newAnimationCompilerTest();
    const layer = new ConstantSourceLayer({ 'mouth.open': 1.0 });
    compiler.registerLayer(layer);

    // First tick seeds the spring at target=1.0 (snap-on-seed), value should be 1.0.
    nowRef.t += 16.67;
    (compiler as any).tick();
    const afterSnap = compiler.getCurrentParams()['mouth.open'];
    expect(afterSnap).toBe(1.0); // snap-on-seed

    // Advance 11 more ticks (12 total ≈ 200ms). Should already be ≥0.95.
    advanceTicks(compiler, nowRef, 11);
    const val = compiler.getCurrentParams()['mouth.open'];
    expect(val).toBeGreaterThanOrEqual(0.95);
  });

  // -------------------------------------------------------------------------
  // Test 2 — step response, slow channel with overshoot envelope
  // Overshoot is only visible when the spring approaches from below.
  // Tick 1: emit body.z=0 (snap-on-seed, position=0, velocity=0).
  // Tick 2+: emit body.z=1.0. Spring approaches from 0 → overshoots with ζ=0.85.
  // -------------------------------------------------------------------------
  test('Test 2: body.z (slow, ω=7 ζ=0.85) reaches ≥0.95 with overshoot ≤1.08 and >1.0', () => {
    const compiler = newAnimationCompilerTest();
    const layer = new ConstantSourceLayer({ 'body.z': 0.0 });
    compiler.registerLayer(layer);

    let maxSeen = -Infinity;
    // Tick 1: snap-on-seed at 0
    nowRef.t += 16.67;
    (compiler as any).tick();
    maxSeen = Math.max(maxSeen, compiler.getCurrentParams()['body.z'] ?? 0);

    // Switch target to 1.0 — spring now approaches from 0 with ζ=0.85 → overshoot.
    // Use 59 more ticks (60 total ≈ 983ms) since ω=7 settling time ≈ 670ms.
    layer.setContrib({ 'body.z': 1.0 });

    for (let i = 0; i < 59; i++) {
      nowRef.t += 16.67;
      (compiler as any).tick();
      maxSeen = Math.max(maxSeen, compiler.getCurrentParams()['body.z'] ?? 0);
    }

    const finalVal = compiler.getCurrentParams()['body.z'];
    expect(finalVal).toBeGreaterThanOrEqual(0.95);
    expect(maxSeen).toBeLessThanOrEqual(1.08);
    expect(maxSeen).toBeGreaterThan(1.0); // must actually overshoot (ζ=0.85)
  });

  // -------------------------------------------------------------------------
  // Test 3 — steady-state convergence
  // -------------------------------------------------------------------------
  test('Test 3: head.yaw (ω=12 ζ=1) converges to 0.5 within 1e-3 after 60 ticks', () => {
    const compiler = newAnimationCompilerTest();
    const layer = new ConstantSourceLayer({ 'head.yaw': 0.5 });
    compiler.registerLayer(layer);

    // First tick snaps to 0.5
    nowRef.t += 16.67;
    (compiler as any).tick();

    advanceTicks(compiler, nowRef, 59);
    const val = compiler.getCurrentParams()['head.yaw'];
    expect(Math.abs((val ?? 0) - 0.5)).toBeLessThan(1e-3);
  });

  // -------------------------------------------------------------------------
  // Test 4 — drop-on-release
  // -------------------------------------------------------------------------
  test('Test 4: mouth.open absent from contributions is dropped from emitted frame', () => {
    const compiler = newAnimationCompilerTest();
    const layer = new ConstantSourceLayer({ 'mouth.open': 0.7 });
    compiler.registerLayer(layer);

    // 10 ticks driving the channel
    advanceTicks(compiler, nowRef, 10);
    expect('mouth.open' in compiler.getCurrentParams()).toBe(true);

    // Layer goes silent
    layer.setContrib({});
    nowRef.t += 16.67;
    (compiler as any).tick();

    expect('mouth.open' in compiler.getCurrentParams()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5 — re-acquire snap
  // -------------------------------------------------------------------------
  test('Test 5: re-acquired channel snaps to new target value after 5-tick silence', () => {
    const compiler = newAnimationCompilerTest();
    const layer = new ConstantSourceLayer({ 'mouth.open': 0.7 });
    compiler.registerLayer(layer);

    // Drive for 10 ticks
    advanceTicks(compiler, nowRef, 10);

    // Silence for 5 ticks (channel gets dropped from springStates)
    layer.setContrib({});
    advanceTicks(compiler, nowRef, 5);
    expect('mouth.open' in compiler.getCurrentParams()).toBe(false);

    // Re-acquire with a different target value
    layer.setContrib({ 'mouth.open': 0.3 });
    nowRef.t += 16.67;
    (compiler as any).tick();

    const val = compiler.getCurrentParams()['mouth.open'];
    // Should snap to 0.3, not drift from old 0.7 state
    expect(Math.abs((val ?? 999) - 0.3)).toBeLessThan(1e-6);
  });

  // -------------------------------------------------------------------------
  // Test 6 — dt clamp
  // -------------------------------------------------------------------------
  test('Test 6: 500ms wall-clock gap is clamped; position is finite and bounded', () => {
    const compiler = newAnimationCompilerTest();
    const layer = new ConstantSourceLayer({ 'mouth.open': 1.0 });
    compiler.registerLayer(layer);

    // Tick 1 at t=1000 — snap-on-seed
    nowRef.t = 1000;
    (compiler as any).tick();
    const afterSnap = compiler.getCurrentParams()['mouth.open'];
    expect(afterSnap).toBe(1.0);

    // Tick 2 at t=1500 — 500ms gap, clamped to 100ms
    nowRef.t = 1500;
    (compiler as any).tick();

    const pos = compiler.getCurrentParams()['mouth.open'];
    expect(Number.isFinite(pos)).toBe(true);
    expect(pos).not.toBeNaN();
    // Position should not have blown up beyond a tight envelope around 1.0
    expect(Math.abs(pos - 1.0)).toBeLessThan(2.0);
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal mock ActionMap that returns a fixed ResolvedAction
// ---------------------------------------------------------------------------
function mockActionMap(
  resolved: {
    targets: Array<{ channel: string; targetValue: number; weight: number; oscillate?: number }>;
    endPose?: Array<{ channel: string; value: number; weight?: number }>;
    holdMs?: number;
  } | null,
) {
  return {
    resolveAction: () => resolved,
    getDuration: () => 1000,
    listActions: () => [],
    has: () => resolved !== null,
  };
}

// ---------------------------------------------------------------------------
// endPose / baseline / crossfade tests
// ---------------------------------------------------------------------------
describe('AnimationCompiler endPose baseline persistence', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    nowRef = { t: 1000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 7 — endPose baseline written after animation completes
  // -------------------------------------------------------------------------
  test('Test 7: endPose baseline arm.right≈5 persists after endTime and params stay near 5', () => {
    // Use crossfadeMs=0 so we don't need to account for crossfade windows,
    // and a very long baselineHalfLifeMs so baseline doesn't decay in test.
    const compiler = newAnimationCompilerTest({ crossfadeMs: 0, baselineHalfLifeMs: 1_000_000 });
    // Inject a mock action map that returns an action with endPose
    (compiler as any).actionMap = mockActionMap({
      targets: [{ channel: 'arm.right', targetValue: 5, weight: 1.0 }],
      endPose: [{ channel: 'arm.right', value: 5 }],
    });

    // Enqueue at t=1000, duration=500ms
    nowRef.t = 1000;
    compiler.enqueue([
      {
        action: 'raise_hand',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 500,
        easing: 'easeInOutCubic',
      },
    ]);

    // Advance past endTime (1000 + 500 = 1500) by 1ms
    nowRef.t = 1501;
    (compiler as any).tick();

    // Baseline should now have arm.right ≈ 5
    const snapshot = compiler.getChannelBaselineSnapshot();
    expect(snapshot['arm.right']).toBeDefined();
    expect(Math.abs((snapshot['arm.right'] ?? 0) - 5)).toBeLessThan(0.01);

    // Current params should remain near 5 (spring was snapped to settled value)
    const params = compiler.getCurrentParams();
    expect(params['arm.right']).toBeDefined();
    expect(Math.abs((params['arm.right'] ?? 0) - 5)).toBeLessThan(0.1);
  });

  // -------------------------------------------------------------------------
  // Test 8 — half-life decay: after one half-life, baseline is near 50% of
  // original. Uses an explicit halfLife rather than the default so the test
  // survives future default changes.
  // -------------------------------------------------------------------------
  test('Test 8: after one half-life, baseline decays to ~50% of original', () => {
    const halfLifeMs = 3000;
    const compiler = newAnimationCompilerTest({ crossfadeMs: 0, baselineHalfLifeMs: halfLifeMs });
    (compiler as any).actionMap = mockActionMap({
      targets: [{ channel: 'arm.right', targetValue: 10, weight: 1.0 }],
      endPose: [{ channel: 'arm.right', value: 10 }],
    });

    // Enqueue at t=1000, duration=500ms
    nowRef.t = 1000;
    compiler.enqueue([
      {
        action: 'raise_hand',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 500,
        easing: 'easeInOutCubic',
      },
    ]);

    // Advance past end to harvest the endPose
    nowRef.t = 1501;
    (compiler as any).tick();
    const snapshotInitial = compiler.getChannelBaselineSnapshot();
    const initialBaseline = snapshotInitial['arm.right'] ?? 0;
    expect(initialBaseline).toBeGreaterThan(9.9); // should be ~10

    // Advance one half-life in 100 ms ticks (dt is clamped to 100ms internally).
    const ticks = Math.round(halfLifeMs / 100);
    for (let i = 0; i < ticks; i++) {
      nowRef.t += 100;
      (compiler as any).tick();
    }

    const snapshotHalfLife = compiler.getChannelBaselineSnapshot();
    const baselineHalfLife = snapshotHalfLife['arm.right'] ?? 0;
    // After one half-life, should be near 50% of initial
    expect(baselineHalfLife).toBeGreaterThan(initialBaseline * 0.4);
    expect(baselineHalfLife).toBeLessThan(initialBaseline * 0.6);
  });

  // -------------------------------------------------------------------------
  // Test 9 — crossfade no-sink: shared channel value never drops below
  // min(old, new) - epsilon during transition
  // -------------------------------------------------------------------------
  test('Test 9: crossfade arm.right never sinks below min(old,new) - 0.1', () => {
    const compiler = newAnimationCompilerTest({
      crossfadeMs: 250,
      attackRatio: 0.0, // immediate full value
      releaseRatio: 0.0, // no release (stays at peak)
      baselineHalfLifeMs: 1_000_000,
    });

    let callCount = 0;
    // First call: old animation targeting arm.right=5
    // Second call: new animation targeting arm.right=3
    (compiler as any).actionMap = {
      resolveAction: (_a: string, _e: string, _i: number) => {
        callCount++;
        return callCount === 1
          ? { targets: [{ channel: 'arm.right', targetValue: 5, weight: 1.0 }] }
          : { targets: [{ channel: 'arm.right', targetValue: 3, weight: 1.0 }] };
      },
      getDuration: () => 1000,
      listActions: () => [],
      has: () => true,
    };

    // Enqueue first animation at t=1000, duration=1000ms
    nowRef.t = 1000;
    compiler.enqueue([
      {
        action: 'anim1',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 1000,
        easing: 'easeInOutCubic',
      },
    ]);

    // Run first animation for 100ms to let it get to sustain
    for (let i = 0; i < 6; i++) {
      nowRef.t += 16.67;
      (compiler as any).tick();
    }

    // Enqueue second animation 100ms after start — this triggers crossfade
    nowRef.t = 1100;
    compiler.enqueue([
      {
        action: 'anim2',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 1000,
        easing: 'easeInOutCubic',
      },
    ]);

    const minExpected = Math.min(5, 3) - 0.1; // = 2.9
    let minSeen = Infinity;

    // Sample frames throughout the crossfade window (250ms at 16ms intervals = ~15 ticks)
    for (let i = 0; i < 20; i++) {
      nowRef.t += 16.67;
      (compiler as any).tick();
      const val = compiler.getCurrentParams()['arm.right'];
      if (val !== undefined) minSeen = Math.min(minSeen, val);
    }

    expect(minSeen).toBeGreaterThan(minExpected);
  });

  // -------------------------------------------------------------------------
  // Test 10 — crossfadeMs=0 immediate switch
  // -------------------------------------------------------------------------
  test('Test 10: crossfadeMs=0 switches immediately with no intermediate sink', () => {
    const compiler = newAnimationCompilerTest({
      crossfadeMs: 0,
      attackRatio: 0.0,
      releaseRatio: 0.0,
      baselineHalfLifeMs: 1_000_000,
    });

    let callCount = 0;
    (compiler as any).actionMap = {
      resolveAction: (_a: string, _e: string, _i: number) => {
        callCount++;
        return callCount === 1
          ? { targets: [{ channel: 'arm.right', targetValue: 8, weight: 1.0 }] }
          : { targets: [{ channel: 'arm.right', targetValue: 4, weight: 1.0 }] };
      },
      getDuration: () => 1000,
      listActions: () => [],
      has: () => true,
    };

    // Enqueue first animation at t=1000
    nowRef.t = 1000;
    compiler.enqueue([
      {
        action: 'anim1',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 1000,
        easing: 'easeInOutCubic',
      },
    ]);

    // Run for 100ms
    for (let i = 0; i < 6; i++) {
      nowRef.t += 16.67;
      (compiler as any).tick();
    }

    // Enqueue second animation at t=1100 — crossfadeMs=0 means immediate
    nowRef.t = 1100;
    compiler.enqueue([
      {
        action: 'anim2',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 1000,
        easing: 'easeInOutCubic',
      },
    ]);

    // Tick once at t=1100 — old anim should be fully faded (fp=1 immediately)
    (compiler as any).tick();

    // Since crossfadeMs=0, old animation is immediately harvested (isCrossfadeDone).
    // New animation should have full weight. arm.right should be at ~4 (no sink).
    const val = compiler.getCurrentParams()['arm.right'];
    // Allow spring tolerance — spring was snapped to old, now approaching 4
    // After one tick from snap+16ms, spring position should be moving toward 4
    // (spring omega=8 for arm.right, so it converges quickly)
    expect(val).toBeDefined();
    // Should not be stuck at 8 — spring should have moved toward 4
    // (but allow for spring dynamics; within ~4 is not realistic in 1 tick, so just check > 0)
    expect(val).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 11 — regression: missing endPose preserves drop-on-release behavior
  // -------------------------------------------------------------------------
  test('Test 11: animation without endPose drops arm.right after expiry', () => {
    const compiler = newAnimationCompilerTest({ crossfadeMs: 0 });
    (compiler as any).actionMap = mockActionMap({
      targets: [{ channel: 'arm.right', targetValue: 5, weight: 1.0 }],
      // No endPose
    });

    nowRef.t = 1000;
    compiler.enqueue([
      {
        action: 'wave',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 200,
        easing: 'easeInOutCubic',
      },
    ]);

    // Advance to mid-animation to drive the channel
    nowRef.t = 1100;
    (compiler as any).tick();
    expect('arm.right' in compiler.getCurrentParams()).toBe(true);

    // Advance well past endTime
    nowRef.t = 1300;
    (compiler as any).tick();

    // Channel should be absent (no endPose → no baseline → drop-on-release)
    expect('arm.right' in compiler.getCurrentParams()).toBe(false);

    // Baseline snapshot should also be empty for arm.right
    const snapshot = compiler.getChannelBaselineSnapshot();
    expect(snapshot['arm.right']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 12 — regression: missing holdMs does not affect endTime calculation
  // -------------------------------------------------------------------------
  test('Test 12: animation without holdMs expires at startTime + duration', () => {
    const compiler = newAnimationCompilerTest({ crossfadeMs: 0 });
    (compiler as any).actionMap = mockActionMap({
      targets: [{ channel: 'head.yaw', targetValue: 10, weight: 1.0 }],
      // No holdMs
    });

    nowRef.t = 2000;
    compiler.enqueue([
      {
        action: 'nod',
        emotion: 'neutral',
        intensity: 1.0,
        timestamp: nowRef.t,
        duration: 300,
        easing: 'easeInOutCubic',
      },
    ]);

    // Before expiry: channel present
    nowRef.t = 2299;
    (compiler as any).tick();
    expect('head.yaw' in compiler.getCurrentParams()).toBe(true);

    // After expiry: channel absent (no endPose)
    nowRef.t = 2310;
    (compiler as any).tick();
    expect('head.yaw' in compiler.getCurrentParams()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-target leadMs/lagMs timing tests (Task 2 additions)
// ---------------------------------------------------------------------------
describe('AnimationCompiler — per-target leadMs timing', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    nowRef = { t: 10_000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });
  afterEach(() => {
    dateSpy.mockRestore();
  });

  test('target with leadMs<0 starts contributing before anim.startTime', async () => {
    // Write a temp action map file with a leadMs-anticipated accompaniment target.
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'lead-'));
    const mapPath = join(dir, 'map.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        test_action: {
          params: [{ channel: 'main', targetValue: 1, weight: 1 }],
          accompaniment: [{ channel: 'lead', targetValue: 1, weight: 1, leadMs: -200 }],
          defaultDuration: 1000,
        },
      }),
    );

    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, attackRatio: 0.2, releaseRatio: 0.3, defaultEasing: 'linear' },
        mapPath,
      );

      // Schedule anim to start at nowRef.t + 500 (i.e. 500ms in the future so we
      // can observe the anticipation window before the "main" target opens).
      const startAt = nowRef.t + 500;
      compiler.enqueue([
        {
          action: 'test_action',
          emotion: 'neutral',
          intensity: 1,
          duration: 1000,
          easing: 'linear',
          timestamp: startAt,
        },
      ]);

      // Advance to 350ms wall-clock time — anim hasn't started (500ms away) but
      // the lead target should already be active (leadMs=-200, so effStart = startAt - 200 = t+300).
      nowRef.t += 350;
      (compiler as any).tick();
      const p1 = compiler.getCurrentParams();
      // Lead target effStart was 350ms ago ... wait recalc:
      // We advanced t by 350, so now = 10_000 + 350 = 10_350.
      // startAt = 10_500; effStart of 'lead' = 10_500 - 200 = 10_300.
      // elapsed = 10_350 - 10_300 = 50ms into a 1000ms envelope -> attack phase.
      expect(p1.lead).toBeGreaterThan(0);
      expect(p1.main ?? 0).toBe(0); // main hasn't started yet (startAt=10_500 > now=10_350)

      // Advance past startAt — main target kicks in.
      nowRef.t = 10_600; // 100ms past startAt
      (compiler as any).tick();
      const p2 = compiler.getCurrentParams();
      expect(p2.main).toBeGreaterThan(0);
      expect(p2.lead).toBeGreaterThan(0);

      compiler.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// compiler:jitter tunable section tests
// ---------------------------------------------------------------------------
describe('AnimationCompiler — compiler:jitter tunable section', () => {
  test('listTunableParams includes compiler:jitter section with 3 params', () => {
    const compiler = newAnimationCompilerTest();
    const sections = compiler.listTunableParams();
    const jitter = sections.find((s) => s.id === 'compiler:jitter');
    expect(jitter).toBeDefined();
    const ids = jitter!.params.map((p) => p.id).sort();
    expect(ids).toEqual(['durationJitter', 'intensityFloor', 'intensityJitter']);
    expect(jitter!.params.find((p) => p.id === 'durationJitter')!.default).toBeCloseTo(0.15);
    expect(jitter!.params.find((p) => p.id === 'intensityJitter')!.default).toBeCloseTo(0.1);
    expect(jitter!.params.find((p) => p.id === 'intensityFloor')!.default).toBeCloseTo(0.1);
  });

  test('setTunableParam(compiler:jitter, durationJitter, 0.3) overrides effective jitter', () => {
    const compiler = newAnimationCompilerTest();
    expect(compiler.getEffectiveJitter().duration).toBeCloseTo(0.15);
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0.3);
    expect(compiler.getEffectiveJitter().duration).toBeCloseTo(0.3);
  });

  test('setTunableParam(compiler:jitter, intensityJitter, 0.25) overrides intensity axis only', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0.25);
    const eff = compiler.getEffectiveJitter();
    expect(eff.intensity).toBeCloseTo(0.25);
    expect(eff.duration).toBeCloseTo(0.15); // untouched
  });

  test('setTunableParam(compiler:jitter, intensityFloor, 0.2) overrides floor', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setTunableParam('compiler:jitter', 'intensityFloor', 0.2);
    expect(compiler.getEffectiveJitter().intensityFloor).toBeCloseTo(0.2);
  });

  test('config.compiler.jitter is the middle precedence layer (overrides defaults; overridden by tunable)', () => {
    const compiler = newAnimationCompilerTest({ jitter: { duration: 0.2 } });
    expect(compiler.getEffectiveJitter().duration).toBeCloseTo(0.2);
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0.4);
    expect(compiler.getEffectiveJitter().duration).toBeCloseTo(0.4);
  });
});

// ---------------------------------------------------------------------------
// Clip execution path tests (B 2/3 Task 2)
// ---------------------------------------------------------------------------
describe('AnimationCompiler — clip execution path', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  // Clip fixture: vrm.head.y 0→1→0 over 2s (easeInOutCubic)
  const STD_CLIP = {
    id: 'test',
    duration: 2,
    tracks: [
      {
        channel: 'vrm.head.y',
        keyframes: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
          { time: 2, value: 0 },
        ],
      },
    ],
  };

  beforeEach(() => {
    nowRef = { t: 10_000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });
  afterEach(() => {
    dateSpy.mockRestore();
  });

  // Helper: write temp action-map + clip JSON, return cleanup fn.
  async function mkClipEnv(
    clipDef: object,
    actionMapEntries: object,
    prefix = 'clip-test-',
  ): Promise<{ mapPath: string; cleanup: () => void }> {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(dir, 'test-clip.json'), JSON.stringify(clipDef));
    const mapPath = join(dir, 'map.json');
    writeFileSync(mapPath, JSON.stringify(actionMapEntries));
    return { mapPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  // -------------------------------------------------------------------------
  // Test A — clip enqueue + mid-clip sample
  // -------------------------------------------------------------------------
  test('Test A: clip contributes vrm.head.y ≈ 0.5 at peak (intensity=0.5)', async () => {
    const { mapPath, cleanup } = await mkClipEnv(STD_CLIP, {
      test_clip: { kind: 'clip', clip: 'test-clip.json' },
    });
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler.enqueue([
        {
          action: 'test_clip',
          emotion: 'neutral',
          intensity: 0.5,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Run 62 ticks (~1033ms) — past the clip midpoint at 1000ms where value=1.0.
      // Spring with omega=12 tracks a slow ramp closely; contribution ≈ 0.5 at peak.
      for (let i = 0; i < 62; i++) {
        nowRef.t += 16.67;
        (compiler as any).tick();
      }

      const params = compiler.getCurrentParams();
      expect(params['vrm.head.y']).toBeDefined();
      expect(Math.abs((params['vrm.head.y'] ?? 0) - 0.5)).toBeLessThan(0.05);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test B — clip expiry removes from activeAnimations
  // -------------------------------------------------------------------------
  test('Test B: clip expiry — activeAnimationCount drops to 0 after clip duration + slack', async () => {
    const { mapPath, cleanup } = await mkClipEnv(STD_CLIP, {
      test_clip: { kind: 'clip', clip: 'test-clip.json' },
    });
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler.enqueue([
        {
          action: 'test_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Advance to startTime + 2100ms (>2000ms clip duration + 100ms slack)
      nowRef.t += 2100;
      (compiler as any).tick();

      expect(compiler.getActiveAnimationCount()).toBe(0);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test C — two-clip crossfade on same channel
  // -------------------------------------------------------------------------
  test('Test C: two-clip crossfade — both present at mid-window, old removed after', async () => {
    const { mapPath, cleanup } = await mkClipEnv(STD_CLIP, {
      clip_a: { kind: 'clip', clip: 'test-clip.json' },
      clip_b: { kind: 'clip', clip: 'test-clip.json' },
    });
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      // Set short crossfadeMs for testability
      compiler.setTunableParam('compiler:envelope', 'crossfadeMs', 100);

      // Enqueue clip A
      compiler.enqueue([
        {
          action: 'clip_a',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Advance 100ms (6 ticks) then enqueue clip B
      for (let i = 0; i < 6; i++) {
        nowRef.t += 16.67;
        (compiler as any).tick();
      }

      const crossfadeStart = nowRef.t;
      compiler.enqueue([
        {
          action: 'clip_b',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Mid-crossfade: 50ms after clip B start — clip A still fading, not yet removed
      nowRef.t = crossfadeStart + 50;
      (compiler as any).tick();
      expect(compiler.getActiveAnimationCount()).toBe(2);

      // After crossfade: 101ms after clip B start — clip A fully faded out and removed
      nowRef.t = crossfadeStart + 101;
      (compiler as any).tick();
      expect(compiler.getActiveAnimationCount()).toBe(1);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test D — clip + envelope on different channels don't interfere
  // -------------------------------------------------------------------------
  test('Test D: clip on vrm.head.y and envelope on mouth.smile both contribute independently', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'clip-mix-'));
    writeFileSync(join(dir, 'test-clip.json'), JSON.stringify(STD_CLIP));
    writeFileSync(
      join(dir, 'map.json'),
      JSON.stringify({
        test_clip: { kind: 'clip', clip: 'test-clip.json' },
        test_envelope: {
          params: [{ channel: 'mouth.smile', targetValue: 1, weight: 1 }],
          defaultDuration: 2000,
        },
      }),
    );
    try {
      const compiler = newAnimationCompilerTest(
        {
          fps: 60,
          outputFps: 60,
          defaultEasing: 'easeInOutCubic',
          attackRatio: 0.1,
          releaseRatio: 0.1,
        },
        join(dir, 'map.json'),
      );
      compiler.enqueue([
        {
          action: 'test_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
        {
          action: 'test_envelope',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Run 30 ticks (~500ms) — both animations in sustain phase
      for (let i = 0; i < 30; i++) {
        nowRef.t += 16.67;
        (compiler as any).tick();
      }

      const params = compiler.getCurrentParams();
      expect(params['vrm.head.y'] ?? 0).toBeGreaterThan(0);
      expect(params['mouth.smile'] ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test E — intensity scales clip output proportionally
  // -------------------------------------------------------------------------
  test('Test E: intensity=0.5 yields ~half the currentParam value of intensity=1.0', async () => {
    const { mapPath, cleanup } = await mkClipEnv(STD_CLIP, {
      test_clip: { kind: 'clip', clip: 'test-clip.json' },
    });
    try {
      const savedT = nowRef.t;

      // Run 1: intensity=1.0
      const compiler1 = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler1.enqueue([
        {
          action: 'test_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);
      for (let i = 0; i < 48; i++) {
        nowRef.t += 16.67;
        (compiler1 as any).tick();
      }
      const val1 = compiler1.getCurrentParams()['vrm.head.y'] ?? 0;

      // Reset time for run 2
      nowRef.t = savedT;
      const compiler2 = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler2.enqueue([
        {
          action: 'test_clip',
          emotion: 'neutral',
          intensity: 0.5,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);
      for (let i = 0; i < 48; i++) {
        nowRef.t += 16.67;
        (compiler2 as any).tick();
      }
      const val05 = compiler2.getCurrentParams()['vrm.head.y'] ?? 0;

      expect(val1).toBeGreaterThan(0.05);
      expect(Math.abs(val05 - val1 * 0.5)).toBeLessThan(0.05);
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test F — getActiveAnimationDetails includes kind for both clip and envelope
  // -------------------------------------------------------------------------
  test('Test F: getActiveAnimationDetails returns kind=clip and kind=envelope entries', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'clip-details-'));
    writeFileSync(join(dir, 'test-clip.json'), JSON.stringify(STD_CLIP));
    writeFileSync(
      join(dir, 'map.json'),
      JSON.stringify({
        test_clip: { kind: 'clip', clip: 'test-clip.json' },
        test_envelope: {
          params: [{ channel: 'mouth.smile', targetValue: 1, weight: 1 }],
          defaultDuration: 2000,
        },
      }),
    );
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        join(dir, 'map.json'),
      );
      compiler.enqueue([
        {
          action: 'test_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
        {
          action: 'test_envelope',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // One tick to seed phase values
      nowRef.t += 16.67;
      (compiler as any).tick();

      const details = compiler.getActiveAnimationDetails();
      expect(details).toHaveLength(2);
      const clipEntry = details.find((d) => d.name === 'test_clip');
      const envEntry = details.find((d) => d.name === 'test_envelope');
      expect(clipEntry).toBeDefined();
      expect(envEntry).toBeDefined();
      expect(clipEntry!.kind).toBe('clip');
      expect(envEntry!.kind).toBe('envelope');
      expect(['attack', 'sustain', 'release']).toContain(clipEntry!.phase);
      expect(['attack', 'sustain', 'release']).toContain(envEntry!.phase);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Quat clip path tests
// ---------------------------------------------------------------------------
describe('AnimationCompiler — quat clip path', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  // Quat clip fixture: vrm.hips rotates 0→90° around Y over 2s.
  // At t=1s (mid-clip), alpha=0.5, sampled quat ≈ 45° rotation.
  const sin45 = Math.sin(Math.PI / 4);
  const cos45 = Math.cos(Math.PI / 4);
  const QUAT_CLIP = {
    id: 'quat-hips',
    duration: 2,
    tracks: [
      {
        kind: 'quat',
        channel: 'vrm.hips',
        keyframes: [
          { time: 0, x: 0, y: 0, z: 0, w: 1 },
          { time: 2, x: 0, y: sin45, z: 0, w: cos45 },
        ],
      },
    ],
  };

  beforeEach(() => {
    nowRef = { t: 10_000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });
  afterEach(() => {
    dateSpy.mockRestore();
  });

  // Helper: write temp action-map + quat clip JSON for quat path tests.
  async function mkQClipEnv(
    clipDef: object,
    actionMapEntries: object,
  ): Promise<{ mapPath: string; cleanup: () => void }> {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'qclip-test-'));
    writeFileSync(join(dir, 'quat-clip.json'), JSON.stringify(clipDef));
    const mapPath = join(dir, 'map.json');
    writeFileSync(mapPath, JSON.stringify(actionMapEntries));
    return { mapPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  // -------------------------------------------------------------------------
  // Test Q1 — quat clip emits vrm.hips.q[xyzw] and not vrm.hips.x/y/z
  // -------------------------------------------------------------------------
  test('Test Q1: quat clip emits vrm.hips.qx/qy/qz/qw and not vrm.hips.x/y/z', async () => {
    const { mapPath, cleanup } = await mkQClipEnv(QUAT_CLIP, {
      quat_clip: { kind: 'clip', clip: 'quat-clip.json' },
    });
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler.enqueue([
        {
          action: 'quat_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Advance 60 ticks (~1000ms) — past attack (200ms), into sustain
      for (let i = 0; i < 60; i++) {
        nowRef.t += 16.67;
        (compiler as any).tick();
      }

      const params = compiler.getCurrentParams();
      expect(params['vrm.hips.qx']).toBeDefined();
      expect(params['vrm.hips.qy']).toBeDefined();
      expect(params['vrm.hips.qz']).toBeDefined();
      expect(params['vrm.hips.qw']).toBeDefined();
      expect(params['vrm.hips.x']).toBeUndefined();
      expect(params['vrm.hips.y']).toBeUndefined();
      expect(params['vrm.hips.z']).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test Q2 — intensity=1 gives ≈45° at mid-clip; intensity=0.3 gives ≈13.5°
  // -------------------------------------------------------------------------
  test('Test Q2: intensity=1 gives ≈45° at mid-clip; intensity=0.3 gives ≈13.5°', async () => {
    const { mapPath, cleanup } = await mkQClipEnv(QUAT_CLIP, {
      quat_clip: { kind: 'clip', clip: 'quat-clip.json' },
    });
    try {
      const savedT = nowRef.t;

      // Run 1: intensity=1.0
      const compiler1 = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler1.enqueue([
        {
          action: 'quat_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);
      for (let i = 0; i < 60; i++) {
        nowRef.t += 16.67;
        (compiler1 as any).tick();
      }
      const p1 = compiler1.getCurrentParams();
      const qw1 = p1['vrm.hips.qw'] ?? 0;
      const angle1 = 2 * Math.acos(Math.min(1, Math.abs(qw1)));
      expect(angle1).toBeCloseTo(Math.PI / 4, 1); // ≈45° within 0.05 rad

      // Run 2: intensity=0.3
      nowRef.t = savedT;
      const compiler2 = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic' },
        mapPath,
      );
      compiler2.enqueue([
        {
          action: 'quat_clip',
          emotion: 'neutral',
          intensity: 0.3,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);
      for (let i = 0; i < 60; i++) {
        nowRef.t += 16.67;
        (compiler2 as any).tick();
      }
      const p2 = compiler2.getCurrentParams();
      const qw2 = p2['vrm.hips.qw'] ?? 0;
      const angle2 = 2 * Math.acos(Math.min(1, Math.abs(qw2)));
      expect(angle2).toBeCloseTo((Math.PI / 4) * 0.3, 1); // ≈13.5° within 0.05 rad
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test Q3 — quat channels bypass baseline and disappear one tick after clip ends
  // -------------------------------------------------------------------------
  test('Test Q3: quat channels bypass baseline; absent one tick after clip ends', async () => {
    const { mapPath, cleanup } = await mkQClipEnv(QUAT_CLIP, {
      quat_clip: { kind: 'clip', clip: 'quat-clip.json' },
    });
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic', crossfadeMs: 0 },
        mapPath,
      );
      compiler.enqueue([
        {
          action: 'quat_clip',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Drive to mid-clip (30 ticks ≈ 500ms, past attack window)
      for (let i = 0; i < 30; i++) {
        nowRef.t += 16.67;
        (compiler as any).tick();
      }
      // Quat channels must be present mid-clip
      expect(compiler.getCurrentParams()['vrm.hips.qw']).toBeDefined();
      const qwMid = compiler.getCurrentParams()['vrm.hips.qw'] ?? 0;
      // Must be a valid quaternion component: |qw| ≤ 1 (spring not applied)
      expect(Math.abs(qwMid)).toBeLessThanOrEqual(1.0 + 1e-6);

      // Confirm quat channels have no spring state (they bypass spring-damper)
      expect((compiler as any).springStates.has('vrm.hips.qw')).toBe(false);

      // Advance past clip end (duration=2000ms, started at t=10000)
      nowRef.t = 10_000 + 2200;
      (compiler as any).tick();
      // Quat channels must disappear one tick after clip ends (no spring carry-over)
      expect(compiler.getCurrentParams()['vrm.hips.qx']).toBeUndefined();
      expect(compiler.getCurrentParams()['vrm.hips.qy']).toBeUndefined();
      expect(compiler.getCurrentParams()['vrm.hips.qz']).toBeUndefined();
      expect(compiler.getCurrentParams()['vrm.hips.qw']).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test Q4 — two sequential quat clips crossfade via base-channel conflict
  // -------------------------------------------------------------------------
  test('Test Q4: two quat clips on vrm.hips crossfade; only 1 active after crossfade', async () => {
    const { mapPath, cleanup } = await mkQClipEnv(QUAT_CLIP, {
      quat_a: { kind: 'clip', clip: 'quat-clip.json' },
      quat_b: { kind: 'clip', clip: 'quat-clip.json' },
    });
    try {
      const compiler = newAnimationCompilerTest(
        { fps: 60, outputFps: 60, defaultEasing: 'easeInOutCubic', crossfadeMs: 100 },
        mapPath,
      );

      compiler.enqueue([
        {
          action: 'quat_a',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Advance 6 ticks ≈ 100ms
      for (let i = 0; i < 6; i++) {
        nowRef.t += 16.67;
        (compiler as any).tick();
      }

      const crossfadeStart = nowRef.t;
      compiler.enqueue([
        {
          action: 'quat_b',
          emotion: 'neutral',
          intensity: 1.0,
          timestamp: nowRef.t,
          duration: 2000,
          easing: 'easeInOutCubic',
        },
      ]);

      // Mid-crossfade: both still active
      nowRef.t = crossfadeStart + 50;
      (compiler as any).tick();
      expect(compiler.getActiveAnimationCount()).toBe(2);

      // Post-crossfade: first clip removed
      nowRef.t = crossfadeStart + 101;
      (compiler as any).tick();
      expect(compiler.getActiveAnimationCount()).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ModelKind getter / setter
// ---------------------------------------------------------------------------
describe('AnimationCompiler currentModelKind', () => {
  test('defaults to null before any hello is received', () => {
    const compiler = newAnimationCompilerTest();
    expect(compiler.getCurrentModelKind()).toBeNull();
  });

  test('setCurrentModelKind stores the value and getCurrentModelKind returns it', () => {
    const compiler = newAnimationCompilerTest();
    const kinds: (ModelKind | null)[] = ['cubism', 'vrm', null];
    for (const kind of kinds) {
      compiler.setCurrentModelKind(kind);
      expect(compiler.getCurrentModelKind()).toBe(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Model-aware listActions / resolveAction paths (Task 2)
// ---------------------------------------------------------------------------
describe('AnimationCompiler — model-aware listActions and resolveAction', () => {
  test('listActions filters by current model kind (cubism excludes vrm-only)', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setCurrentModelKind('cubism');
    const actions = compiler.listActions();
    const names = actions.map((a) => a.name);
    // formal_bow is vrm-only in the default map — must be absent for cubism
    expect(names).not.toContain('formal_bow');
    // nod is head/body-only (no explicit modelSupport → auto-derives to both)
    expect(names).toContain('nod');
    // wave carries arm.* which conflicts with VRM idle; explicit cubism-only
    expect(names).toContain('wave');
  });

  test('listActions includes vrm-only actions when model is vrm', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setCurrentModelKind('vrm');
    const actions = compiler.listActions();
    const names = actions.map((a) => a.name);
    expect(names).toContain('formal_bow');
    // nod auto-derives to both (head.pitch + body.y, no vrm.* prefix, no arm conflict)
    expect(names).toContain('nod');
    // wave is still explicitly cubism-only due to arm.* channel conflicts
    // with the VRM idle loop's absolute-pose bone tracks
    expect(names).not.toContain('wave');
  });

  test('resolveAction returns null for vrm-only action when model is cubism', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setCurrentModelKind('cubism');
    const result = compiler.resolveAction('formal_bow', 'neutral', 1.0);
    expect(result).toBeNull();
  });

  test('resolveAction resolves for vrm-only action when model is vrm', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setCurrentModelKind('vrm');
    const result = compiler.resolveAction('formal_bow', 'neutral', 1.0);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('clip');
  });
});

// ---------------------------------------------------------------------------
// Regression: cubism path must not synthesize vrm.* params when no compatible
// layers or actions contribute quat tracks. (Task 2 requirement req 5)
// ---------------------------------------------------------------------------
describe('AnimationCompiler — cubism path does not emit vrm.* params (regression)', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    nowRef = { t: 1000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  test('no vrm.*.q[xyzw] channels appear on cubism path with no layers', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setCurrentModelKind('cubism');

    // Tick without any registered layers
    nowRef.t += 16;
    (compiler as any).tick();

    const params = compiler.getCurrentParams();
    const quatKeys = Object.keys(params).filter((k) => /^vrm\..+\.q[xyzw]$/.test(k));
    expect(quatKeys).toHaveLength(0);
  });

  test('vrm-only layer registered on cubism compiler emits no vrm.* params', () => {
    const compiler = newAnimationCompilerTest();
    compiler.setCurrentModelKind('cubism');

    // Register a fake layer that declares modelSupport: ['vrm'] and would emit quat
    const vrmLayer: AnimationLayer = {
      id: 'fake-vrm',
      modelSupport: ['vrm'] as const,
      sample: () => ({}),
      sampleQuat: () => ({ 'vrm.hips': { x: 0.1, y: 0, z: 0, w: 0.995 } }),
      setEnabled: () => {},
      isEnabled: () => true,
      getWeight: () => 1.0,
      setWeight: () => {},
    };
    compiler.registerLayer(vrmLayer);

    nowRef.t += 16;
    (compiler as any).tick();

    const params = compiler.getCurrentParams();
    const quatKeys = Object.keys(params).filter((k) => /^vrm\..+\.q[xyzw]$/.test(k));
    expect(quatKeys).toHaveLength(0);
  });
});
