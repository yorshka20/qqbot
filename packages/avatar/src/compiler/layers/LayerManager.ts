import type { AvatarActivity } from '../../state/types';
import type { ModelKind } from '../types';
import type { AnimationLayer } from './types';

/** Aggregated per-tick layer output — scalar (weighted, ambient-gated) and
 *  quat (absolute, neither weighted nor ambient-gated). */
export interface LayerFrame {
  scalar: Record<string, number>;
  quat: Record<string, { x: number; y: number; z: number; w: number }>;
}

/**
 * Registry + sampler for `AnimationLayer` instances.
 *
 * `sample(nowMs, activity)` walks every registered layer and returns a
 * `LayerFrame` with two maps:
 *
 * - `scalar` — additively merged across layers, each contribution multiplied
 *   by the layer's weight and the activity's `ambientGain`. Delta-style
 *   layers (breath / blink / perlin / gaze) fade to silence when the gate
 *   closes.
 * - `quat` — absolute quaternion poses, last-writer-wins, NOT scaled by
 *   weight or ambientGain. An idle loop's elbow bend stays structurally
 *   correct while the bot is speaking (a 0.3× quaternion is not a 0.3×
 *   bend — it's a partial slerp toward identity, which is a different pose,
 *   not a dimmed one).
 *
 * `activity.ambientGain` is the gate directly — pipeline / plugin code
 * writes whatever scalar they want (0..1) and LayerManager reads it.
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
   * `nowMs`. `activeChannels` is the set of channel ids that active discrete
   * animations will drive this tick — forwarded to each layer so that layers
   * holding absolute values (VRM idle clips) can skip colliding channels.
   * The returned map is mutable and owned by the caller; the manager does
   * not retain a reference.
   *
   * `modelKind` — when non-null, layers whose `modelSupport` is defined but
   * does not include this kind are skipped entirely (both scalar and quat).
   * When null, no filtering is applied (backward-compatible).
   */
  sample(
    nowMs: number,
    activity: AvatarActivity,
    activeChannels?: ReadonlySet<string>,
    modelKind?: ModelKind | null,
  ): LayerFrame {
    const gateValue = activity.ambientGain;
    const scalar: Record<string, number> = {};
    const quat: Record<string, { x: number; y: number; z: number; w: number }> = {};

    for (const layer of this.layers.values()) {
      if (!layer.isEnabled()) continue;

      // Model-kind filtering: skip layers incompatible with the current model.
      // Only filter when modelKind is non-null and layer declares modelSupport.
      if (modelKind != null && layer.modelSupport !== undefined) {
        if (!layer.modelSupport.includes(modelKind)) continue;
      }

      const weight = layer.getWeight();
      const effective = gateValue * weight;

      // Scalar path — ambient-gated and weight-scaled. Skipped entirely when
      // the gate is closed so delta-style layers (breath/blink/perlin) go
      // silent during non-idle states.
      if (effective !== 0) {
        const contribs = layer.sample(nowMs, activity, activeChannels);
        for (const [channel, value] of Object.entries(contribs)) {
          scalar[channel] = (scalar[channel] ?? 0) + value * effective;
        }
      }

      // Quat path — absolute poses. Neither weight nor ambientGain applies,
      // so an idle loop's elbow bend stays structurally correct even while
      // the bot is speaking. Last-writer-wins on key collision; layers
      // targeting the same bone should not coexist.
      if (layer.sampleQuat) {
        const qContribs = layer.sampleQuat(nowMs, activity, activeChannels);
        for (const [bone, q] of Object.entries(qContribs)) {
          quat[bone] = q;
        }
      }
    }
    return { scalar, quat };
  }
}
