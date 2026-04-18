import type { BotState } from '../state/types';
import type { AmbientDriver } from './AmbientDriver';

/** Gate function: calm ambient during concentration states. */
function defaultGate(state: BotState): number {
  if (state === 'idle') return 1.0;
  if (state === 'listening') return 0.8;
  if (state === 'thinking') return 0.5;
  if (state === 'speaking') return 0.3;
  if (state === 'reacting') return 0.4;
  return 1.0;
}

/**
 * Baseline breath driver — mirrors pixi-live2d-display's Cubism4 default
 * breath config (±15° head yaw period 6.5s, etc.) but authored in bot's
 * semantic channel units (head.* in degrees, body.* in normalized [-1,1]).
 * Different channel oscillators use different periods + phases so the
 * composite motion feels natural (not rigidly sinusoidal).
 */
export const DEFAULT_AMBIENT_DRIVERS: AmbientDriver[] = [
  {
    id: 'baseline-breath',
    channels: {
      'head.yaw': { amplitude: 15, periodSec: 6.5, phase: 0 },
      'head.pitch': { amplitude: 8, periodSec: 3.5, phase: Math.PI / 3 },
      'head.roll': { amplitude: 10, periodSec: 5.5, phase: Math.PI / 2 },
      'body.x': { amplitude: 0.13, periodSec: 15.5, phase: 0 },
    },
    gate: defaultGate,
  },
];
