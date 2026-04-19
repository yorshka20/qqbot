/**
 * AnimationCompiler spring-damper tests.
 *
 * NOTE: `(compiler as any).tick()` is a deliberate deterministic-testing
 * escape hatch. The real `tick()` is private (driven by setInterval), but
 * calling it directly lets tests control wall-clock time via a mocked
 * `Date.now` and advance the simulation at a fixed dt without relying on
 * real timers.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AvatarActivity } from '../state/types';
import { AnimationCompiler } from './AnimationCompiler';
import type { AnimationLayer } from './layers/types';

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
    const compiler = new AnimationCompiler();
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
    const compiler = new AnimationCompiler();
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
    const compiler = new AnimationCompiler();
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
    const compiler = new AnimationCompiler();
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
    const compiler = new AnimationCompiler();
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
  // Test 6 — deprecated smoothingFactor ignored
  // -------------------------------------------------------------------------
  test('Test 6: smoothingFactor: 0.01 does not throttle mouth.open (deprecated field)', () => {
    const compiler = new AnimationCompiler({ smoothingFactor: 0.01 });
    const layer = new ConstantSourceLayer({ 'mouth.open': 1.0 });
    compiler.registerLayer(layer);

    // First tick snaps, then 11 more
    nowRef.t += 16.67;
    (compiler as any).tick();
    advanceTicks(compiler, nowRef, 11);

    const val = compiler.getCurrentParams()['mouth.open'];
    // If smoothingFactor=0.01 were still active, mouth.open would be ~0.11 after 12 ticks.
    // Spring-damper ignores it, so the value should be ≥0.95.
    expect(val).toBeGreaterThanOrEqual(0.95);
  });

  // -------------------------------------------------------------------------
  // Test 7 — dt clamp
  // -------------------------------------------------------------------------
  test('Test 7: 500ms wall-clock gap is clamped; position is finite and bounded', () => {
    const compiler = new AnimationCompiler();
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
