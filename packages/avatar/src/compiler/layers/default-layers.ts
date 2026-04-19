import { AutoBlinkLayer } from './AutoBlinkLayer';
import { BreathLayer } from './BreathLayer';
import { EyeGazeLayer } from './EyeGazeLayer';
import { IdleMotionLayer } from './IdleMotionLayer';
import type { AnimationLayer } from './types';

/**
 * Instantiate the default animation layer stack (breath + blink + gaze +
 * idle-motion). Each call returns fresh instances, safe to register on a
 * compiler independently. Callers wanting a subset can construct individual
 * layers directly from this module's exports.
 */
export function createDefaultLayers(): AnimationLayer[] {
  return [new BreathLayer(), new AutoBlinkLayer(), new EyeGazeLayer(), new IdleMotionLayer()];
}
