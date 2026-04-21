import type { CompilerConfig } from '../types';
import { AmbientAudioLayer } from './AmbientAudioLayer';
import { AutoBlinkLayer } from './AutoBlinkLayer';
import { BreathLayer } from './BreathLayer';
import { EyeGazeLayer } from './EyeGazeLayer';
import { IdleMotionLayer } from './IdleMotionLayer';
import { PerlinNoiseLayer } from './PerlinNoiseLayer';
import type { AnimationLayer } from './types';
import { WalkingLayer } from './WalkingLayer';

/**
 * Instantiate the default animation layer stack (breath + blink + gaze +
 * idle-motion + walking). Each call returns fresh instances, safe to
 * register on a compiler independently. Callers wanting a subset can
 * construct individual layers directly from this module's exports.
 */
export function createDefaultLayers(compilerConfig?: Partial<CompilerConfig>): AnimationLayer[] {
  const walkConfig = compilerConfig?.walk ?? {};

  const perlinNoiseLayer = new PerlinNoiseLayer();
  const layers: AnimationLayer[] = [
    new BreathLayer(),
    new AutoBlinkLayer(),
    new EyeGazeLayer(),
    new IdleMotionLayer(),
    new WalkingLayer({
      speedMps: walkConfig.speedMps,
      arrivalThresholdM: walkConfig.arrivalThresholdM,
    }),
    new AmbientAudioLayer(),
    perlinNoiseLayer,
  ];
  perlinNoiseLayer.setWeight(0.2);
  return layers;
}
