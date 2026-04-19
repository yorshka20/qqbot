import type { BotState } from '../../state/types';
import { type AnimationLayer, DEFAULT_LAYER_GATE, type LayerGate } from './types';

/**
 * Registry + sampler for `AnimationLayer` instances.
 *
 * `sample(nowMs, state)` walks every registered layer, asks it for its current
 * channel contributions, applies the per-layer weight and the global gate, and
 * additively merges the results. The result is a single channel map the
 * compiler folds into its per-tick contributions.
 *
 * One global gate (`LayerGate`) governs all layers; per-layer weight is
 * available on the `AnimationLayer` itself for finer control.
 */
export class LayerManager {
  private readonly layers: Map<string, AnimationLayer> = new Map();
  private gate: LayerGate = DEFAULT_LAYER_GATE;

  /** Replace the global gate policy. */
  setGate(gate: LayerGate): void {
    this.gate = gate;
  }

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
  sample(nowMs: number, state: BotState): Record<string, number> {
    const gateValue = this.gate(state);
    const out: Record<string, number> = {};
    if (gateValue === 0) return out;

    for (const layer of this.layers.values()) {
      if (!layer.isEnabled()) continue;
      const weight = layer.getWeight();
      const effective = gateValue * weight;
      if (effective === 0) continue;

      const contribs = layer.sample(nowMs, state);
      for (const [channel, value] of Object.entries(contribs)) {
        out[channel] = (out[channel] ?? 0) + value * effective;
      }
    }
    return out;
  }
}
