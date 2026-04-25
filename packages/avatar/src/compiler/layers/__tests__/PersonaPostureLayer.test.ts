import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import type { GazeDistribution } from '../EyeGazeLayer';
import { LayerManager } from '../LayerManager';
import { PersonaPostureLayer } from '../PersonaPostureLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1 };
const IDLE_ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1 };

/** Advance the layer by N ticks of 16ms and return the final sample. */
function runTicks(layer: PersonaPostureLayer, ticks: number, startMs = 0): Record<string, number> {
  let result: Record<string, number> = {};
  for (let i = 0; i < ticks; i++) {
    result = layer.sample(startMs + i * 16, ACTIVITY);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — default state', () => {
  test('fresh layer emits no output channels', () => {
    const layer = new PersonaPostureLayer();
    // First tick at t=0 — all targets are 0, so smoothed values stay 0.
    const result = layer.sample(0, ACTIVITY);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('running many ticks without setBias still emits nothing', () => {
    const layer = new PersonaPostureLayer();
    const result = runTicks(layer, 200);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setBias no-op
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — setBias({})', () => {
  test('setBias({}) on fresh layer is a no-op — output remains empty', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({});
    const result = layer.sample(0, ACTIVITY);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('setBias({}) on a layer with active bias leaves values unchanged', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 0.5 });
    // Converge: 600 ticks × 16 ms = 9 600 ms ≈ 8 × tau (1 200 ms), giving
    // >99.9% convergence so the residual smoothing step is < 1e-6 rad.
    const beforeResult = runTicks(layer, 600);
    const beforeSpine = beforeResult['vrm.spine.x'];

    layer.setBias({}); // no-op
    // One more tick — targets unchanged, smoothed values should be stable
    const afterResult = layer.sample(600 * 16 + 16, ACTIVITY);
    const afterSpine = afterResult['vrm.spine.x'];

    // Values should be essentially equal (within floating-point tolerance)
    expect(afterSpine).toBeCloseTo(beforeSpine ?? 0, 4);
  });
});

// ---------------------------------------------------------------------------
// Channel sign correctness
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — channel sign', () => {
  test('postureLean=1 → vrm.spine.x and vrm.chest.x are positive after convergence', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1 });
    const result = runTicks(layer, 200);
    expect(result['vrm.spine.x'] ?? 0).toBeGreaterThan(0);
    expect(result['vrm.chest.x'] ?? 0).toBeGreaterThan(0);
  });

  test('postureLean=-1 → vrm.spine.x and vrm.chest.x are negative after convergence', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: -1 });
    const result = runTicks(layer, 200);
    expect(result['vrm.spine.x'] ?? 0).toBeLessThan(0);
    expect(result['vrm.chest.x'] ?? 0).toBeLessThan(0);
  });

  test('headTiltBias=1 → vrm.head.z is positive after convergence', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ headTiltBias: 1 });
    const result = runTicks(layer, 200);
    expect(result['vrm.head.z'] ?? 0).toBeGreaterThan(0);
  });

  test('headTiltBias=-1 → vrm.head.z is negative after convergence', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ headTiltBias: -1 });
    const result = runTicks(layer, 200);
    expect(result['vrm.head.z'] ?? 0).toBeLessThan(0);
  });

  test('postureLean clamps at ±1 (value > 1 treated as 1)', () => {
    const layer1 = new PersonaPostureLayer();
    layer1.setBias({ postureLean: 1 });
    const r1 = runTicks(layer1, 200);

    const layer2 = new PersonaPostureLayer();
    layer2.setBias({ postureLean: 99 });
    const r2 = runTicks(layer2, 200);

    // Clamped to 1 — both layers should converge to the same spine value
    expect(r2['vrm.spine.x']).toBeCloseTo(r1['vrm.spine.x'] ?? 0, 4);
  });
});

// ---------------------------------------------------------------------------
// activeChannels exclusion
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — activeChannels exclusion', () => {
  test('channel in activeChannels is absent from output', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1 });
    runTicks(layer, 150); // converge first
    const t = 150 * 16;

    const excluded = new Set(['vrm.spine.x']);
    const result = layer.sample(t, ACTIVITY, excluded);
    expect(result['vrm.spine.x']).toBeUndefined();
    // chest.x is NOT in the exclusion set; it should still be present
    expect(result['vrm.chest.x'] ?? 0).toBeGreaterThan(0);
  });

  test('all posture channels excluded → empty output', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1, headTiltBias: 1 });
    runTicks(layer, 150);
    const t = 150 * 16;

    const excluded = new Set(['vrm.spine.x', 'vrm.chest.x', 'vrm.head.z']);
    const result = layer.sample(t, ACTIVITY, excluded);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('empty activeChannels set does not suppress any channels', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1, headTiltBias: 1 });
    runTicks(layer, 150);
    const t = 150 * 16;

    const result = layer.sample(t, ACTIVITY, new Set());
    expect(result['vrm.spine.x'] ?? 0).not.toBe(0);
    expect(result['vrm.chest.x'] ?? 0).not.toBe(0);
    expect(result['vrm.head.z'] ?? 0).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ambientGain=0 via LayerManager
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — LayerManager ambient gating', () => {
  test('ambientGain=0 yields zero effective scalar contribution', () => {
    const manager = new LayerManager();
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1, headTiltBias: 1 });
    // Pre-converge the layer standalone (manager.register calls reset, so
    // we need to pre-warm via register then run ticks through the manager)
    manager.register(layer);
    for (let t = 0; t < 200 * 16; t += 16) {
      manager.sample(t, IDLE_ACTIVITY, undefined, 'vrm');
    }

    // Gate fully closed
    const frame = manager.sample(200 * 16, { pose: 'neutral', ambientGain: 0 }, undefined, 'vrm');
    for (const v of Object.values(frame.scalar)) {
      expect(v).toBeCloseTo(0, 6);
    }
  });

  test('ambientGain=1 yields non-zero scalar contribution after convergence', () => {
    const manager = new LayerManager();
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1 });
    manager.register(layer);

    let frame = { scalar: {} as Record<string, number>, scalarBypass: {}, quat: {} };
    for (let t = 0; t < 200 * 16; t += 16) {
      frame = manager.sample(t, IDLE_ACTIVITY, undefined, 'vrm');
    }

    expect(frame.scalar['vrm.spine.x'] ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Smoothing behaviour
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — smoothing', () => {
  test('first tick after setBias produces a smaller offset than the converged value', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1 });

    // Single tick — smoothing has barely moved
    const firstResult = layer.sample(16, ACTIVITY);
    const firstSpine = firstResult['vrm.spine.x'] ?? 0;

    // Converge over ~3s
    const convergedResult = runTicks(layer, 200, 32);
    const convergedSpine = convergedResult['vrm.spine.x'] ?? 0;

    expect(Math.abs(firstSpine)).toBeLessThan(Math.abs(convergedSpine));
  });

  test('after convergence, setBias(0) smoothly decays back toward zero', () => {
    const layer = new PersonaPostureLayer();
    layer.setBias({ postureLean: 1 });
    const convergedResult = runTicks(layer, 200);
    const convergedSpine = convergedResult['vrm.spine.x'] ?? 0;

    // Reverse bias
    layer.setBias({ postureLean: 0 });

    // One tick — should still be close to converged value
    const immediateResult = layer.sample(200 * 16 + 16, ACTIVITY);
    const immediateSpine = immediateResult['vrm.spine.x'] ?? 0;

    // After convergence toward 0
    const decayedResult = runTicks(layer, 200, 200 * 16 + 32);
    const decayedSpine = decayedResult['vrm.spine.x'] ?? 0;

    // Converged-toward-0 should be significantly smaller than the peak
    expect(Math.abs(immediateSpine)).toBeGreaterThan(Math.abs(decayedSpine ?? 0));
    expect(Math.abs(convergedSpine)).toBeGreaterThan(Math.abs(decayedSpine ?? 0));
  });
});

// ---------------------------------------------------------------------------
// gazeContactPreference wiring
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — gazeContactPreference forwarding', () => {
  test('setBias with gazeContactPreference calls setDefaultContactPreference on the wired layer', () => {
    let capturedPref: number | null = undefined as unknown as number | null;
    const fakeBias = {
      setDefaultContactPreference(pref: number | null): void {
        capturedPref = pref;
      },
      setGazeDistribution(_dist: GazeDistribution | null): void {},
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({ gazeContactPreference: 0.8 });
    expect(capturedPref).toBeCloseTo(0.8, 5);
  });

  test('setBias with gazeContactPreference=null forwards null to clear the preference', () => {
    let capturedPref: number | null = 99;
    const fakeBias = {
      setDefaultContactPreference(pref: number | null): void {
        capturedPref = pref;
      },
      setGazeDistribution(_dist: GazeDistribution | null): void {},
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({ gazeContactPreference: null });
    expect(capturedPref).toBeNull();
  });

  test('setBias({}) does NOT call setDefaultContactPreference (no-op)', () => {
    let called = false;
    const fakeBias = {
      setDefaultContactPreference(_pref: number | null): void {
        called = true;
      },
      setGazeDistribution(_dist: GazeDistribution | null): void {},
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({});
    expect(called).toBe(false);
  });

  test('gazeContactPreference is clamped to [0, 1] before forwarding', () => {
    let capturedPref: number | null = null;
    const fakeBias = {
      setDefaultContactPreference(pref: number | null): void {
        capturedPref = pref;
      },
      setGazeDistribution(_dist: GazeDistribution | null): void {},
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);

    layer.setBias({ gazeContactPreference: 5 });
    expect(capturedPref).toBeCloseTo(1, 5);

    layer.setBias({ gazeContactPreference: -3 });
    expect(capturedPref).toBeCloseTo(0, 5);
  });
});

// ---------------------------------------------------------------------------
// gazeDistribution forwarding
// ---------------------------------------------------------------------------

describe('PersonaPostureLayer — gazeDistribution forwarding', () => {
  test('setBias with gazeDistribution calls setGazeDistribution and NOT setDefaultContactPreference', () => {
    const captured = { dist: undefined as GazeDistribution | null | undefined, called: false };
    let prefCalled = false;
    const fakeBias = {
      setDefaultContactPreference(_pref: number | null): void {
        prefCalled = true;
      },
      setGazeDistribution(dist: GazeDistribution | null): void {
        captured.dist = dist;
        captured.called = true;
      },
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({ gazeDistribution: { camera: 0.5, down: 0.5 } });

    expect(captured.called).toBe(true);
    expect(captured.dist).toEqual({ camera: 0.5, down: 0.5 });
    expect(prefCalled).toBe(false);
  });

  test('setBias with gazeDistribution=null forwards null via setGazeDistribution', () => {
    let setGazeDistributionCalled = false;
    let capturedDistValue: GazeDistribution | null = { camera: 1 }; // non-null sentinel
    const fakeBias = {
      setDefaultContactPreference(_pref: number | null): void {},
      setGazeDistribution(dist: GazeDistribution | null): void {
        setGazeDistributionCalled = true;
        capturedDistValue = dist;
      },
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({ gazeDistribution: null });

    expect(setGazeDistributionCalled).toBe(true);
    expect(capturedDistValue).toBeNull();
  });

  test('gazeDistribution wins over gazeContactPreference when both present', () => {
    let distCalled = false;
    let prefCalled = false;
    const fakeBias = {
      setDefaultContactPreference(_pref: number | null): void {
        prefCalled = true;
      },
      setGazeDistribution(_dist: GazeDistribution | null): void {
        distCalled = true;
      },
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({ gazeDistribution: { camera: 1 }, gazeContactPreference: 0.5 });

    expect(distCalled).toBe(true);
    expect(prefCalled).toBe(false);
  });

  test('setBias with only gazeContactPreference (no gazeDistribution key) calls setDefaultContactPreference only', () => {
    let distCalled = false;
    let capturedPref: number | null = null;
    const fakeBias = {
      setDefaultContactPreference(pref: number | null): void {
        capturedPref = pref;
      },
      setGazeDistribution(_dist: GazeDistribution | null): void {
        distCalled = true;
      },
    };

    const layer = new PersonaPostureLayer();
    layer.setEyeGazeLayer(fakeBias);
    layer.setBias({ gazeContactPreference: 0.8 });

    expect(capturedPref).toBeCloseTo(0.8, 5);
    expect(distCalled).toBe(false);
  });
});
