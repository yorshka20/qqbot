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

  test('walkTo(0, 0, Math.PI / 2) snaps facing immediately and emits the final root frame', async () => {
    const layer = new WalkingLayer();
    let arrived: { x: number; z: number; facing: number } | null = null;

    layer.onArrive((pos) => {
      arrived = pos;
    });

    const walk = layer.walkTo(0, 0, Math.PI / 2);
    const frame = sampleTick(layer, 0);
    await flush();
    await walk;

    expect(frame).toEqual({
      'vrm.root.x': 0,
      'vrm.root.z': 0,
      'vrm.root.rotY': Math.PI / 2,
    });
    expect(arrived).not.toBeNull();
    expect(arrived!).toEqual({ x: 0, z: 0, facing: Math.PI / 2 });
    expect(layer.getPosition()).toEqual({ x: 0, z: 0, facing: Math.PI / 2 });
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
    const frame = sampleTick(layer, 0);
    // Root channels still present (use direct key access — toHaveProperty treats '.' as nested path).
    expect(frame['vrm.root.x']).toBeDefined();
    expect(frame['vrm.root.z']).toBeDefined();
    expect(frame['vrm.root.rotY']).toBeDefined();
    // Scalar bone channel from clip
    expect(frame['vrm.head.y']).toBeCloseTo(0.1, 5);
    // Quat bone channel flattened to qx/qy/qz/qw
    expect(frame['vrm.hips.qx']).toBeDefined();
    expect(frame['vrm.hips.qy']).toBeDefined();
    expect(frame['vrm.hips.qz']).toBeDefined();
    expect(frame['vrm.hips.qw']).toBeCloseTo(1, 5);
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
    const frame = layer.sample(100, IDLE); // pending is null → must be {}
    await flush();
    expect(frame).toEqual({});
    expect(await rejection).toBeInstanceOf(WalkInterruptedError);
  });
});
