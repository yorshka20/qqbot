/**
 * Rest pose tests — verify:
 *   1. `mergeRestPose` helper merges user entries with defaults (user overrides).
 *   2. `AnimationCompiler` tick step 7.5 fills restPose values only for channels
 *      no layer / active animation drove this tick (override semantic, not additive).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AvatarActivity } from '../state/types';
import { AnimationCompiler } from './AnimationCompiler';
import type { AnimationLayer } from './layers/types';
import { DEFAULT_VRM_REST_POSE, mergeRestPose } from './rest-pose';

class FixedLayer implements AnimationLayer {
  id = 'fixed-layer';
  private _enabled = true;
  private _weight = 1.0;
  constructor(private contrib: Record<string, number>) {}
  sample(_n: number, _a: AvatarActivity): Record<string, number> {
    return this._enabled ? { ...this.contrib } : {};
  }
  setEnabled(e: boolean): void {
    this._enabled = e;
  }
  isEnabled(): boolean {
    return this._enabled;
  }
  getWeight(): number {
    return this._weight;
  }
  setWeight(w: number): void {
    this._weight = w;
  }
}

describe('mergeRestPose helper', () => {
  test('returns a copy of DEFAULT_VRM_REST_POSE when user is undefined', () => {
    const merged = mergeRestPose(undefined);
    expect(merged).toEqual(DEFAULT_VRM_REST_POSE);
    // Verify the returned object is a fresh copy (not the same reference).
    expect(merged).not.toBe(DEFAULT_VRM_REST_POSE);
  });

  test('user entries override defaults per key, other defaults preserved', () => {
    const merged = mergeRestPose({ 'vrm.leftUpperArm.z': -1.5 });
    expect(merged['vrm.leftUpperArm.z']).toBe(-1.5);
    // Right arm default preserved.
    expect(merged['vrm.rightUpperArm.z']).toBe(DEFAULT_VRM_REST_POSE['vrm.rightUpperArm.z']);
  });

  test('user adding a new channel keeps defaults intact', () => {
    const merged = mergeRestPose({ 'vrm.head.z': 0.1 });
    expect(merged['vrm.head.z']).toBe(0.1);
    expect(merged['vrm.leftUpperArm.z']).toBe(DEFAULT_VRM_REST_POSE['vrm.leftUpperArm.z']);
  });

  test('user setting a key to 0 disables that default (emits 0 instead of the built-in offset)', () => {
    const merged = mergeRestPose({ 'vrm.leftUpperArm.z': 0 });
    expect(merged['vrm.leftUpperArm.z']).toBe(0);
    expect(merged['vrm.rightUpperArm.z']).toBe(DEFAULT_VRM_REST_POSE['vrm.rightUpperArm.z']);
  });
});

describe('AnimationCompiler restPose integration', () => {
  let nowRef: { t: number };
  let dateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    nowRef = { t: 1000 };
    dateSpy = spyOn(Date, 'now').mockImplementation(() => nowRef.t);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  test('restPose fills channels no one else drove this tick', () => {
    const compiler = new AnimationCompiler({
      restPose: { 'vrm.leftUpperArm.z': -1.2, 'vrm.rightUpperArm.z': 1.2 },
    });
    nowRef.t += 16.67;
    (compiler as any).tick();
    const params = compiler.getCurrentParams();
    // First tick snap-seeds spring state at target, so values arrive directly.
    expect(params['vrm.leftUpperArm.z']).toBeCloseTo(-1.2, 6);
    expect(params['vrm.rightUpperArm.z']).toBeCloseTo(1.2, 6);
  });

  test('layer writing a restPose channel wins — restPose value is NOT added', () => {
    const compiler = new AnimationCompiler({
      restPose: { 'vrm.leftUpperArm.z': -1.2 },
    });
    // Layer writes +0.5 on the same channel restPose targets.
    compiler.registerLayer(new FixedLayer({ 'vrm.leftUpperArm.z': 0.5 }));
    nowRef.t += 16.67;
    (compiler as any).tick();
    const params = compiler.getCurrentParams();
    // Expected: 0.5 (layer only), NOT 0.5 + (-1.2) = -0.7 and NOT -1.2.
    expect(params['vrm.leftUpperArm.z']).toBeCloseTo(0.5, 6);
  });

  test('restPose values merge with DEFAULT_VRM_REST_POSE through the constructor', () => {
    // Only override left; right should still get the default.
    const compiler = new AnimationCompiler({
      restPose: { 'vrm.leftUpperArm.z': -1.5 },
    });
    nowRef.t += 16.67;
    (compiler as any).tick();
    const params = compiler.getCurrentParams();
    expect(params['vrm.leftUpperArm.z']).toBeCloseTo(-1.5, 6);
    expect(params['vrm.rightUpperArm.z']).toBeCloseTo(
      DEFAULT_VRM_REST_POSE['vrm.rightUpperArm.z'],
      6,
    );
  });

  test('non-restPose channels are unaffected', () => {
    const compiler = new AnimationCompiler({
      restPose: { 'vrm.leftUpperArm.z': -1.2 },
    });
    compiler.registerLayer(new FixedLayer({ 'head.yaw': 5 }));
    nowRef.t += 16.67;
    (compiler as any).tick();
    const params = compiler.getCurrentParams();
    expect(params['head.yaw']).toBeCloseTo(5, 6);
    expect(params['vrm.leftUpperArm.z']).toBeCloseTo(-1.2, 6);
  });
});
