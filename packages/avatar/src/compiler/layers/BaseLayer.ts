import type { AvatarActivity } from '../../state/types';
import type { AnimationLayer } from './types';

/**
 * Convenience base implementing the `AnimationLayer` enable/weight bookkeeping.
 * Concrete layers only need to override `sample()` (and optionally `reset()`).
 */
export abstract class BaseLayer implements AnimationLayer {
  abstract readonly id: string;

  private enabled = true;
  private weight = 1.0;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getWeight(): number {
    return this.weight;
  }

  setWeight(weight: number): void {
    this.weight = weight;
  }

  abstract sample(
    nowMs: number,
    activity: AvatarActivity,
    activeChannels?: ReadonlySet<string>,
  ): Record<string, number>;

  reset?(): void;
}
