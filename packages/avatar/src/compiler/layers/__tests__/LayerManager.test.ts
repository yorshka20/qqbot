/**
 * LayerManager model-kind filtering tests.
 *
 * Verifies that:
 * - A layer with modelSupport:['vrm'] is skipped when modelKind='cubism'
 *   (neither scalar nor quat is sampled).
 * - The same layer runs when modelKind='vrm'.
 * - A layer with no modelSupport declaration remains active for null,
 *   'cubism', and 'vrm' (backward-compatible behavior).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../../state/types';
import type { ModelKind } from '../../types';
import { LayerManager } from '../LayerManager';
import type { AnimationLayer } from '../types';

// ---------------------------------------------------------------------------
// Minimal fake layer implementation
// ---------------------------------------------------------------------------
class FakeLayer implements AnimationLayer {
  readonly id: string;
  readonly modelSupport?: readonly ModelKind[];
  private enabled = true;
  private weight = 1.0;
  /** Count of times sample() was invoked */
  sampleCallCount = 0;
  /** Count of times sampleQuat() was invoked */
  sampleQuatCallCount = 0;

  constructor(id: string, modelSupport?: readonly ModelKind[]) {
    this.id = id;
    this.modelSupport = modelSupport;
  }

  sample(): Record<string, number> {
    this.sampleCallCount++;
    return { [`${this.id}.channel`]: 1.0 };
  }

  sampleQuat(): Record<string, { x: number; y: number; z: number; w: number }> {
    this.sampleQuatCallCount++;
    return { [`${this.id}.bone`]: { x: 0, y: 0, z: 0, w: 1 } };
  }

  setEnabled(e: boolean): void {
    this.enabled = e;
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  getWeight(): number {
    return this.weight;
  }
  setWeight(w: number): void {
    this.weight = w;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LayerManager — model-kind filtering', () => {
  test('vrm-only layer is skipped when modelKind=cubism', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('vrm-only', ['vrm']);
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'cubism');

    // Layer must not have been called at all
    expect(layer.sampleCallCount).toBe(0);
    expect(layer.sampleQuatCallCount).toBe(0);
    // No contributions in the returned frame
    expect(Object.keys(frame.scalar)).toHaveLength(0);
    expect(Object.keys(frame.quat)).toHaveLength(0);
  });

  test('vrm-only layer runs when modelKind=vrm', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('vrm-only', ['vrm']);
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'vrm');

    expect(layer.sampleCallCount).toBe(1);
    expect(layer.sampleQuatCallCount).toBe(1);
    expect(frame.scalar['vrm-only.channel']).toBe(1.0);
    expect(frame.quat['vrm-only.bone']).toBeDefined();
  });

  test('undeclared layer (no modelSupport) stays active for modelKind=null', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('no-decl');
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, null);

    expect(layer.sampleCallCount).toBe(1);
    expect(frame.scalar['no-decl.channel']).toBe(1.0);
  });

  test('undeclared layer stays active for modelKind=cubism', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('no-decl');
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'cubism');

    expect(layer.sampleCallCount).toBe(1);
    expect(frame.scalar['no-decl.channel']).toBe(1.0);
  });

  test('undeclared layer stays active for modelKind=vrm', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('no-decl');
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'vrm');

    expect(layer.sampleCallCount).toBe(1);
    expect(frame.scalar['no-decl.channel']).toBe(1.0);
  });

  test('cubism-only layer is skipped when modelKind=vrm', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('cubism-only', ['cubism']);
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'vrm');

    expect(layer.sampleCallCount).toBe(0);
    expect(Object.keys(frame.scalar)).toHaveLength(0);
  });

  test('cubism-only layer runs when modelKind=cubism', () => {
    const manager = new LayerManager();
    const layer = new FakeLayer('cubism-only', ['cubism']);
    manager.register(layer);

    const frame = manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'cubism');

    expect(layer.sampleCallCount).toBe(1);
    expect(frame.scalar['cubism-only.channel']).toBe(1.0);
  });

  test('multiple layers: compatible ones run, incompatible ones are skipped', () => {
    const manager = new LayerManager();
    const vrmLayer = new FakeLayer('vrm-layer', ['vrm']);
    const cubismLayer = new FakeLayer('cubism-layer', ['cubism']);
    const bothLayer = new FakeLayer('both-layer'); // no modelSupport = both
    manager.register(vrmLayer);
    manager.register(cubismLayer);
    manager.register(bothLayer);

    // When modelKind=cubism: cubismLayer + bothLayer run; vrmLayer is skipped
    manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'cubism');
    expect(cubismLayer.sampleCallCount).toBe(1);
    expect(bothLayer.sampleCallCount).toBe(1);
    expect(vrmLayer.sampleCallCount).toBe(0);

    // When modelKind=vrm: vrmLayer + bothLayer run; cubismLayer is skipped
    manager.sample(0, { ...DEFAULT_ACTIVITY, ambientGain: 1 }, undefined, 'vrm');
    expect(vrmLayer.sampleCallCount).toBe(1);
    expect(bothLayer.sampleCallCount).toBe(2);
    expect(cubismLayer.sampleCallCount).toBe(1); // unchanged
  });
});
