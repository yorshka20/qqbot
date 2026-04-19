import type { AvatarActivity } from '../../state/types';
import type { AnimationLayer } from './types';

/**
 * Registry + sampler for `AnimationLayer` instances.
 *
 * `sample(nowMs, activity)` walks every registered layer, asks it for its
 * current channel contributions, applies the per-layer weight and the global
 * ambient gain (read directly from `activity.ambientGain`), and additively
 * merges the results. The result is a single channel map the compiler folds
 * into its per-tick contributions.
 *
 * The old configurable `LayerGate` / `DEFAULT_LAYER_GATE` indirection is gone:
 * `activity.ambientGain` IS the gate — pipeline / plugin code writes whatever
 * scalar they want (0..1) and LayerManager just reads it. This keeps the
 * "ambient vs. discrete-action split" a single number, matching the intent
 * stated in the design note in `state/types.ts`.
 */
export class LayerManager {
  private readonly layers: Map<string, AnimationLayer> = new Map();

  /** Register or replace a layer by id. */
  register(layer: AnimationLayer): void {
    this.layers.set(layer.id, layer);
    layer.reset?.();
  }

  unregister(id: string): boolean {
    return this.layers.delete(id);
  }

  get(id: string): AnimationLayer | undefined {
    return this.layers.get(id);
  }

  list(): AnimationLayer[] {
    return [...this.layers.values()];
  }

  clear(): void {
    this.layers.clear();
  }

  /**
   * Collect additive per-channel contributions from all enabled layers at
   * `nowMs`. The returned map is mutable and owned by the caller; the
   * manager does not retain a reference.
   */
  sample(nowMs: number, activity: AvatarActivity): Record<string, number> {
    const gateValue = activity.ambientGain;
    const out: Record<string, number> = {};
    if (gateValue === 0) return out;

    for (const layer of this.layers.values()) {
      if (!layer.isEnabled()) continue;
      const weight = layer.getWeight();
      const effective = gateValue * weight;
      if (effective === 0) continue;

      const contribs = layer.sample(nowMs, activity);
      for (const [channel, value] of Object.entries(contribs)) {
        out[channel] = (out[channel] ?? 0) + value * effective;
      }
    }
    return out;
  }
}
