import { describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../state/types';
import { WalkInterruptedError, WalkingLayer } from './WalkingLayer';

const IDLE = DEFAULT_ACTIVITY;
const TICK_MS = 16.67;

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
