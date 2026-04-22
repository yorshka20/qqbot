import { describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../state/types';
import type { IdleClip } from './clips/types';
import { WalkInterruptedError, WalkingLayer } from './WalkingLayer';

const IDLE = DEFAULT_ACTIVITY;
const TICK_MS = 16.67;

// ---------------------------------------------------------------------------
// Deterministic clip fixtures for walk-cycle tests
// ---------------------------------------------------------------------------

/** Clip with one scalar bone track and one quat bone track; no root tracks. */
const FAKE_CLIP: IdleClip = {
  id: 'fake-walk',
  duration: 1.0,
  tracks: [
    {
      kind: 'scalar',
      channel: 'vrm.head.y',
      keyframes: [
        { time: 0, value: 0.1 },
        { time: 1, value: 0.1 },
      ],
    },
    {
      kind: 'quat',
      channel: 'vrm.hips',
      keyframes: [
        { time: 0, x: 0, y: 0, z: 0, w: 1 },
        { time: 1, x: 0, y: 0, z: 0, w: 1 },
      ],
    },
  ],
};

/**
 * Linear clip: scalar channel value equals the clip position in seconds.
 * Long duration (4 s) so rate tests do not accidentally loop.
 */
const LINEAR_CLIP: IdleClip = {
  id: 'linear',
  duration: 4.0,
  tracks: [
    {
      kind: 'scalar',
      channel: 'vrm.leftArm.y',
      // Explicit linear easing so value = clip-position-in-seconds, no cubic distortion.
      easing: 'linear',
      keyframes: [
        { time: 0, value: 0 },
        { time: 4, value: 4 },
      ],
    },
  ],
};

async function flush(): Promise<void> {
  await Promise.resolve();
}

function sampleTick(layer: WalkingLayer, nowMs: number): Record<string, number> {
  return layer.sample(nowMs, IDLE);
}

describe('WalkingLayer – config defaults', () => {
  // Regression: `{ ...DEFAULT, ...{speedMps: undefined} }` used to silently
  // clobber the default to undefined, producing NaN frames on the wire —
  // renderer saw `vrm.root.x: null` and the avatar only rotated.
  test('undefined fields in config fall back to defaults (no NaN in frame)', () => {
    const layer = new WalkingLayer({ speedMps: undefined, arrivalThresholdM: undefined });
    layer.walkTo(1, 0, 0);
    const frame = layer.sample(16.67, IDLE);
    expect(Number.isFinite(frame['vrm.root.x'])).toBe(true);
    expect(Number.isFinite(frame['vrm.root.z'])).toBe(true);
    expect(Number.isFinite(frame['vrm.root.rotY'])).toBe(true);
    // A single ~16ms tick at default 1.0 m/s should move ~16mm toward +x.
    expect(frame['vrm.root.x']).toBeGreaterThan(0);
    expect(frame['vrm.root.x']).toBeLessThan(0.1);
  });
});

describe('WalkingLayer', () => {
  test('walkTo(1, 0, 0) converges within about 1.1s and resolves at the target', async () => {
    const layer = new WalkingLayer();
    let settledAt: number | null = null;
    let currentTime = 0;

    const walk = layer.walkTo(1, 0, 0).then(() => {
      settledAt = currentTime;
    });

    for (let i = 0; i < 80 && settledAt === null; i++) {
      currentTime = i * TICK_MS;
      sampleTick(layer, currentTime);
      await flush();
    }

    await walk;

    expect(settledAt).not.toBeNull();
    expect(settledAt!).toBeLessThanOrEqual(1100);

    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(1, 3);
    expect(pos.z).toBeCloseTo(0, 3);
    expect(pos.facing).toBeCloseTo(0, 3);
  });

  test('walkTo(0, 0, Math.PI / 2) interpolates facing at angularSpeed and arrives within the computed time', async () => {
    // Default angularSpeedRadPerSec = π, so a 90° turn (π/2 rad) resolves in ~500ms.
    // The old snap-on-arrival semantic is gone; facing now interpolates linearly at the
    // configured angular speed just like translation interpolates at speedMps.
    const layer = new WalkingLayer();
    let arrived: { x: number; z: number; facing: number } | null = null;
    let settledAt: number | null = null;
    let currentTime = 0;
    layer.onArrive((pos) => {
      arrived = pos;
    });

    const walk = layer.walkTo(0, 0, Math.PI / 2).then(() => {
      settledAt = currentTime;
    });

    // Advance at 30Hz for up to 1s; expected arrival around 500ms.
    for (let i = 0; i < 35 && settledAt === null; i++) {
      currentTime = i * TICK_MS;
      sampleTick(layer, currentTime);
      await flush();
    }
    await walk;

    expect(settledAt).not.toBeNull();
    // Allow generous slack for tick granularity + arrival threshold.
    expect(settledAt!).toBeLessThanOrEqual(600);
    expect(settledAt!).toBeGreaterThanOrEqual(450);

    expect(arrived).not.toBeNull();
    expect(arrived!.x).toBeCloseTo(0, 6);
    expect(arrived!.z).toBeCloseTo(0, 6);
    expect(arrived!.facing).toBeCloseTo(Math.PI / 2, 3);
    expect(layer.getPosition().facing).toBeCloseTo(Math.PI / 2, 3);
  });

  test('walkTo() interrupts the previous promise and reports the mid-walk position', async () => {
    const layer = new WalkingLayer();
    let firstError: WalkInterruptedError | null = null;
    const first = layer.walkTo(10, 0, 0).catch((error: unknown) => {
      firstError = error as WalkInterruptedError;
    });

    for (let i = 0; i < 30; i++) {
      sampleTick(layer, i * TICK_MS);
    }

    const midPos = layer.getPosition();
    layer.walkTo(20, 0, 0);
    await flush();

    await first;
    expect(firstError).not.toBeNull();
    expect(firstError!).toBeInstanceOf(WalkInterruptedError);
    expect(firstError!.finalPos.x).toBeCloseTo(midPos.x, 6);
    expect(firstError!.finalPos.z).toBeCloseTo(midPos.z, 6);
    expect(firstError!.finalPos.facing).toBeCloseTo(midPos.facing, 6);
  });

  test('stop() interrupts the pending walk and later sample() returns {}', async () => {
    const layer = new WalkingLayer();
    const rejection = layer.walkTo(10, 0, 0).catch((error: unknown) => error);

    for (let i = 0; i < 20; i++) {
      sampleTick(layer, i * TICK_MS);
    }

    layer.stop();
    const result = sampleTick(layer, 500);
    await flush();

    expect(result).toEqual({});
    expect(await rejection).toBeInstanceOf(WalkInterruptedError);
  });

  test('onStartWalk receives the target payload', () => {
    const layer = new WalkingLayer();
    const targets: Array<{ x: number; z: number; facing: number }> = [];

    layer.onStartWalk((target) => {
      targets.push(target);
    });

    layer.walkTo(3, 4, Math.PI);

    expect(targets).toEqual([{ x: 3, z: 4, facing: Math.PI }]);
  });

  test('onWalking is throttled and emits the expected progress payload shape', () => {
    const layer = new WalkingLayer();
    const progressEvents: Array<{
      currentPos: { x: number; z: number };
      currentFacing: number;
      target: { x: number; z: number; facing: number };
      remainingM: number;
    }> = [];

    layer.onWalking((progress) => {
      progressEvents.push(progress);
    });

    layer.walkTo(5, 0, 0);
    for (let i = 0; i < 60; i++) {
      sampleTick(layer, i * TICK_MS);
    }

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.length).toBeLessThanOrEqual(6);
    expect(progressEvents[0].currentPos.x).toBeGreaterThan(0);
    expect(progressEvents[0].currentPos.z).toBeCloseTo(0, 6);
    expect(progressEvents[0].currentFacing).toBeCloseTo(0, 6);
    expect(progressEvents[0].target).toEqual({ x: 5, z: 0, facing: 0 });
    expect(progressEvents[0].remainingM).toBeGreaterThan(0);
  });

  test('onArrive fires exactly once and does not fire before arrival', () => {
    const layer = new WalkingLayer();
    const arrivals: Array<{ x: number; z: number; facing: number }> = [];

    layer.onArrive((pos) => {
      arrivals.push(pos);
    });

    layer.walkTo(0.3, 0, 0);

    for (let i = 0; i < 10; i++) {
      sampleTick(layer, i * TICK_MS);
    }
    expect(arrivals).toHaveLength(0);

    for (let i = 10; i < 30; i++) {
      sampleTick(layer, i * TICK_MS);
    }
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toEqual({ x: 0.3, z: 0, facing: 0 });

    sampleTick(layer, 600);
    expect(arrivals).toHaveLength(1);
  });

  test('sample() with no pending walk returns {}', () => {
    const layer = new WalkingLayer();

    expect(sampleTick(layer, 100)).toEqual({});
  });

  test('reset() clears position to zeros and rejects the pending walk', async () => {
    const layer = new WalkingLayer();
    const rejection = layer.walkTo(10, 0, 0).catch((error: unknown) => error);

    for (let i = 0; i < 12; i++) {
      sampleTick(layer, i * TICK_MS);
    }

    layer.reset();
    await flush();

    expect(layer.getPosition()).toEqual({ x: 0, z: 0, facing: 0 });
    expect(sampleTick(layer, 700)).toEqual({});
    expect(await rejection).toBeInstanceOf(WalkInterruptedError);
  });
});

describe('WalkingLayer – walk-cycle clip', () => {
  test('no clip: walking emits only the 3 root channels', () => {
    const layer = new WalkingLayer();
    layer.walkTo(10, 0, 0);
    const frame = sampleTick(layer, 0);
    expect(Object.keys(frame).sort()).toEqual(['vrm.root.rotY', 'vrm.root.x', 'vrm.root.z'].sort());
  });

  test('setWalkCycleClip(null) reverts to slide-only output', () => {
    const layer = new WalkingLayer();
    layer.setWalkCycleClip(FAKE_CLIP);
    layer.setWalkCycleClip(null);
    layer.walkTo(10, 0, 0);
    const frame = sampleTick(layer, 0);
    expect(Object.keys(frame).sort()).toEqual(['vrm.root.rotY', 'vrm.root.x', 'vrm.root.z'].sort());
  });

  test('clip with scalar and quat tracks emits non-root bone channels while walking', () => {
    const layer = new WalkingLayer();
    layer.setWalkCycleClip(FAKE_CLIP);
    layer.walkTo(10, 0, 0);
    const nowMs = 0;
    const frame = sampleTick(layer, nowMs);
    // Root channels still present (scalar path; use direct key access —
    // toHaveProperty treats '.' as nested path).
    expect(frame['vrm.root.x']).toBeDefined();
    expect(frame['vrm.root.z']).toBeDefined();
    expect(frame['vrm.root.rotY']).toBeDefined();
    // Scalar bone channel from clip routes through sample() (absolute-scalar
    // bypass pipeline in the compiler, not ambient-gated).
    expect(frame['vrm.head.y']).toBeCloseTo(0.1, 5);
    // Quat bone channels are returned from sampleQuat() — NOT flattened into
    // the scalar return of sample() (would otherwise bypass the quat-path
    // bypass and go through spring-damper with invalid unit-quat math).
    expect(frame['vrm.hips.qx']).toBeUndefined();
    const quatFrame = layer.sampleQuat(nowMs, IDLE);
    expect(quatFrame['vrm.hips']).toBeDefined();
    expect(quatFrame['vrm.hips'].w).toBeCloseTo(1, 5);
  });

  test('clip vrm.root.x track is suppressed; root motion is WalkingLayer-only', () => {
    const clipWithRoot: IdleClip = {
      id: 'with-root',
      duration: 1.0,
      tracks: [
        {
          kind: 'scalar',
          channel: 'vrm.root.x',
          keyframes: [
            { time: 0, value: 999 },
            { time: 1, value: 999 },
          ],
        },
      ],
    };
    const layer = new WalkingLayer({ speedMps: 1.0, arrivalThresholdM: 0.001, onWalkingThrottleMs: 10000 });
    layer.setWalkCycleClip(clipWithRoot);
    layer.walkTo(10, 0, 0);
    const frame = sampleTick(layer, 0);
    // vrm.root.x should be the small WalkingLayer step, never 999
    expect(frame['vrm.root.x']).toBeDefined();
    expect(frame['vrm.root.x']).toBeLessThan(1);
  });

  test('clamp low: speedMps=0.1 behaves identically to speedMps=0.2 (floor of 0.2)', () => {
    // speedMps=0.1 → actualStepMps/authoredSpeed = 0.1 → clamped to 0.2
    // speedMps=0.2 → ratio = 0.2 → exactly at floor, no clamping
    // Both layers should advance the cycle identically.
    function measureAt(speedMps: number): number {
      const layer = new WalkingLayer({ speedMps, arrivalThresholdM: 0.001, onWalkingThrottleMs: 10000 });
      layer.setWalkCycleClip(LINEAR_CLIP, 1.0);
      layer.walkTo(1000, 0, 0);
      layer.sample(0, IDLE); // warm-up tick (dtMs = 16.67)
      const frame = layer.sample(100, IDLE); // controlled dt = 100 ms
      return frame['vrm.leftArm.y'] as number;
    }
    expect(measureAt(0.1)).toBeCloseTo(measureAt(0.2), 4);
  });

  test('clamp high: speedMps=10 behaves identically to speedMps=2.0 (ceiling of 2.0)', () => {
    // speedMps=10 → ratio = 10 → clamped to 2.0
    // speedMps=2.0 → ratio = 2.0 → exactly at ceiling, no clamping
    function measureAt(speedMps: number): number {
      const layer = new WalkingLayer({ speedMps, arrivalThresholdM: 0.001, onWalkingThrottleMs: 10000 });
      layer.setWalkCycleClip(LINEAR_CLIP, 1.0);
      layer.walkTo(1000, 0, 0);
      layer.sample(0, IDLE); // warm-up tick
      const frame = layer.sample(100, IDLE);
      return frame['vrm.leftArm.y'] as number;
    }
    expect(measureAt(10)).toBeCloseTo(measureAt(2.0), 4);
  });

  test('speed coupling: half-speed walk for double time advances the cycle identically', () => {
    // dtMs is capped at 100 ms, so use tick intervals ≤ 100 ms for precise control.
    // After warm-up (dtMs = 16.67), the next tick provides a controlled delta:
    //   A (speed=0.5, dt=50 ms): cycle delta = 50 * 0.5 = 25 ms → value delta = 0.025 s
    //   B (speed=1.0, dt=25 ms): cycle delta = 25 * 1.0 = 25 ms → value delta = 0.025 s
    // For the linear clip (value = t_sec), both deltas equal 0.025.
    function measureDelta(speedMps: number, dt2Ms: number): number {
      const layer = new WalkingLayer({ speedMps, arrivalThresholdM: 0.001, onWalkingThrottleMs: 10000 });
      layer.setWalkCycleClip(LINEAR_CLIP, 1.0);
      layer.walkTo(1000, 0, 0);
      const frame0 = layer.sample(0, IDLE); // warm-up (dtMs = 16.67)
      const frame1 = layer.sample(dt2Ms, IDLE); // dt2Ms ≤ 100 ms
      return (frame1['vrm.leftArm.y'] as number) - (frame0['vrm.leftArm.y'] as number);
    }
    const deltaHalfSpeed = measureDelta(0.5, 50);
    const deltaFullSpeed = measureDelta(1.0, 25);
    expect(deltaHalfSpeed).toBeCloseTo(0.025, 4);
    expect(deltaFullSpeed).toBeCloseTo(0.025, 4);
  });

  test('stop() clears bone contribution on next sample', async () => {
    const layer = new WalkingLayer();
    layer.setWalkCycleClip(FAKE_CLIP);
    const rejection = layer.walkTo(100, 0, 0).catch((e: unknown) => e);
    layer.sample(0, IDLE); // walking tick — clip channels appear
    layer.stop();
    const frame = layer.sample(100, IDLE); // motion cleared → must be {}
    await flush();
    expect(frame).toEqual({});
    expect(await rejection).toBeInstanceOf(WalkInterruptedError);
  });
});

// ---------------------------------------------------------------------------
// Semantic primitives — character-local frame resolution
// ---------------------------------------------------------------------------
describe('WalkingLayer – semantic primitives', () => {
  async function runUntilDone(layer: WalkingLayer, p: Promise<void>, maxTicks = 200): Promise<number> {
    let t = 0;
    let settled = false;
    void p.finally(() => {
      settled = true;
    });
    for (let i = 0; i < maxTicks && !settled; i++) {
      t = i * TICK_MS;
      sampleTick(layer, t);
      await flush();
    }
    await p;
    return t;
  }

  test('walkForward translates along current facing (+Z when facing=0)', async () => {
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.walkForward(1));
    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(0, 3);
    expect(pos.z).toBeCloseTo(1, 3);
    expect(pos.facing).toBeCloseTo(0, 6); // facing preserved
  });

  test('walkForward(negative) walks backward', async () => {
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.walkForward(-0.5));
    const pos = layer.getPosition();
    expect(pos.z).toBeCloseTo(-0.5, 3);
  });

  test('walkForward respects rotated facing (+X when facing=+π/2)', async () => {
    // Three.js Y rotation: facing=+π/2 → forward_world = (sin π/2, cos π/2) = (1, 0) = +X.
    // Bypass the turn() path by seeding facing through walkTo (which interpolates in a long
    // step at maxTicks default) — simpler: directly call turn first, await it, then walkForward.
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.turn(Math.PI / 2));
    await runUntilDone(layer, layer.walkForward(1));
    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(1, 3);
    expect(pos.z).toBeCloseTo(0, 3);
  });

  test('strafe(+m) moves to character-right (+X when facing=0)', async () => {
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.strafe(1));
    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(1, 3);
    expect(pos.z).toBeCloseTo(0, 3);
    expect(pos.facing).toBeCloseTo(0, 6);
  });

  test('strafe is character-local: same +m gives mirrored world motion when facing=π', async () => {
    // facing=+π → character faces -Z. Their own right is now -X in world. So strafe(+1)
    // should move character to -X.
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.turn(Math.PI));
    await runUntilDone(layer, layer.strafe(1));
    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(-1, 3);
    expect(pos.z).toBeCloseTo(0, 3);
  });

  test('turn(+rad) rotates facing by +rad (positive = character right)', async () => {
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.turn(Math.PI / 4));
    expect(layer.getPosition().facing).toBeCloseTo(Math.PI / 4, 3);
  });

  test('turn does not change x/z', async () => {
    const layer = new WalkingLayer();
    await runUntilDone(layer, layer.turn(Math.PI / 2));
    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.z).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------
describe('WalkingLayer – orbit', () => {
  async function runUntilDone(layer: WalkingLayer, p: Promise<void>, maxTicks = 400): Promise<void> {
    let settled = false;
    void p.finally(() => {
      settled = true;
    });
    for (let i = 0; i < maxTicks && !settled; i++) {
      sampleTick(layer, i * TICK_MS);
      await flush();
    }
    await p;
  }

  test('orbit(sweepRad=2π) returns the character to start position', async () => {
    const layer = new WalkingLayer({ speedMps: 2.0 }); // faster so the 2π*radius distance resolves in reasonable tick count
    await runUntilDone(layer, layer.orbit({ sweepRad: 2 * Math.PI, radius: 1.0 }));
    const pos = layer.getPosition();
    // Full revolution — character returns to ~origin within thresholdM.
    expect(pos.x).toBeCloseTo(0, 2);
    expect(pos.z).toBeCloseTo(0, 2);
  });

  test('orbit with keepFacingTangent=true rotates facing along the arc', async () => {
    // Start at (0,0) facing=0. Default centre is radius to the left = (-1, 0). Start polar
    // angle around centre = atan2(0, 1) = 0. Half CCW sweep brings character to (-2, 0)
    // with tangent direction pointing -Z (facing = π).
    const layer = new WalkingLayer({ speedMps: 2.0 });
    await runUntilDone(layer, layer.orbit({ sweepRad: Math.PI, radius: 1.0 }));
    const pos = layer.getPosition();
    expect(pos.x).toBeCloseTo(-2, 2);
    expect(pos.z).toBeCloseTo(0, 2);
    // Facing ≈ ±π (both represent "looking -Z"); normaliseAngle returns one in [-π, π].
    expect(Math.abs(pos.facing)).toBeCloseTo(Math.PI, 2);
  });

  test('orbit with keepFacingTangent=false preserves start facing when no targetFacing given', async () => {
    const layer = new WalkingLayer({ speedMps: 2.0 });
    await runUntilDone(layer, layer.orbit({ sweepRad: Math.PI, radius: 1.0, keepFacingTangent: false }));
    expect(layer.getPosition().facing).toBeCloseTo(0, 3);
  });

  test('orbit emits only vrm.root.* scalar channels (no stray body channels)', () => {
    const layer = new WalkingLayer();
    layer.orbit({ sweepRad: 2 * Math.PI, radius: 1.0 });
    const frame = sampleTick(layer, 0);
    expect(Object.keys(frame).sort()).toEqual(['vrm.root.rotY', 'vrm.root.x', 'vrm.root.z'].sort());
  });

  test('a new orbit interrupts a pending linear walk', async () => {
    const layer = new WalkingLayer();
    const first = layer.walkTo(100, 0, 0).catch((e: unknown) => e as WalkInterruptedError);
    for (let i = 0; i < 5; i++) sampleTick(layer, i * TICK_MS);
    layer.orbit({ sweepRad: Math.PI / 4, radius: 1.0 });
    const err = await first;
    expect(err).toBeInstanceOf(WalkInterruptedError);
  });
});
