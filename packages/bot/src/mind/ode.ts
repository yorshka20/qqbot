/**
 * Stateless ODE step functions for the mind phenotype.
 *
 * Kept pure + side-effect-free so they can be unit-tested in isolation
 * and composed differently later (e.g. running at non-uniform tick
 * intervals, or replaying a stimulus log for offline analysis).
 *
 * Phase 1 models two axes — fatigue and attention — with simple rules:
 *   - fatigue accumulates when the avatar is "busy" (pose ≠ idle) and
 *     decays when truly idle;
 *   - attention decays exponentially toward 0 during silence, and spikes
 *     on every stimulus.
 *
 * Later phases will layer mood (PAD), arousal baseline, and cross-axis
 * interaction on top; today we keep them decoupled so the first integration
 * is easy to reason about.
 */

import type { PersonaPostureBias } from '@qqbot/avatar';
import type { CoreDNA } from './personaStore/CoreDNALoader';
import type { MindConfig, Phenotype, Stimulus } from './types';

/** Clamp to [0, 1]. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Advance the phenotype by `dtMs`. `isActive` should be true whenever
 * the avatar is in a non-idle pose (speaking / listening / thinking /
 * reacting) — this is what causes fatigue to grow.
 *
 * Attention decays by `exp(-dt/τ)`; fatigue moves linearly by the
 * configured per-ms rate. The linear approximation is fine for 1s ticks.
 */
export function tickPhenotype(prev: Phenotype, dtMs: number, isActive: boolean, config: MindConfig): Phenotype {
  if (dtMs <= 0) return prev;
  const fatigueDelta = isActive ? config.ode.fatigueAccrualPerMs * dtMs : -config.ode.fatigueRestDecayPerMs * dtMs;
  const attentionMultiplier = Math.exp(-dtMs / Math.max(1, config.ode.tauAttentionMs));
  return {
    fatigue: clamp01(prev.fatigue + fatigueDelta),
    attention: clamp01(prev.attention * attentionMultiplier),
    stimulusCount: prev.stimulusCount,
    lastStimulusAt: prev.lastStimulusAt,
  };
}

/**
 * Apply a stimulus instantaneously. Called synchronously from the event
 * subscription handler (not from the tick loop) so stimulus spikes
 * are not smeared across a tick boundary.
 */
export function applyStimulus(prev: Phenotype, stimulus: Stimulus, config: MindConfig): Phenotype {
  switch (stimulus.kind) {
    case 'message':
      return {
        ...prev,
        attention: clamp01(prev.attention + config.ode.attentionSpikePerMessage),
        stimulusCount: prev.stimulusCount + 1,
        lastStimulusAt: stimulus.ts,
      };
    default:
      return prev;
  }
}

/** Initial phenotype for a fresh session / persona. */
export function freshPhenotype(): Phenotype {
  return {
    fatigue: 0,
    attention: 0,
    stimulusCount: 0,
    lastStimulusAt: undefined,
  };
}

/**
 * Project the phenotype onto avatar modulation scalars.
 *
 * Phase 1 only wires fatigue → intensity/speed; everything else is left
 * at identity (1.0 / 0). This keeps the observable change narrow and
 * easy to tune: higher fatigue → lower intensity + slower motion.
 */
export function deriveModulation(
  phenotype: Phenotype,
  config: MindConfig,
): {
  intensityScale: number;
  speedScale: number;
  durationBias: number;
} {
  const fatigue = clamp01(phenotype.fatigue);
  return {
    intensityScale: 1 - config.modulation.fatigueIntensityDrop * fatigue,
    speedScale: 1 - config.modulation.fatigueSpeedDrop * fatigue,
    durationBias: 0,
  };
}

/**
 * Project the phenotype onto PersonaPostureBias including a gaze probability distribution.
 *
 * Model: fatigue → less eye contact, more side + down gaze.
 * valence (if present on Phenotype): negative → look down (sadness);
 * positive → more eye contact (confidence). Since Phenotype does not yet
 * have `valence` in Phase 1, it is safely defaulted to 0 via a type cast —
 * DO NOT add valence to Phenotype in this change.
 *
 * All outputs are in PersonaPostureLayer's documented ranges: lean and
 * headTilt in [-1, 1], distribution weights are non-negative.
 */
export function derivePersonaPostureBias(
  phenotype: Phenotype,
  spatial: CoreDNA['modulation']['spatial'],
): PersonaPostureBias {
  const fatigue = clamp01(phenotype.fatigue);
  // Safe default: Phenotype does not yet define valence (Phase 1).
  const rawValence = (phenotype as { valence?: number }).valence ?? 0;
  const valence = Math.max(-1, Math.min(1, rawValence));

  let camera = spatial.gazeDistributionBaseline.camera;
  let side = spatial.gazeDistributionBaseline.side;
  let down = spatial.gazeDistributionBaseline.down;

  // Fatigue → less eye contact, more side + down
  camera -= fatigue * spatial.fatigueResponse.cameraDrop;
  side += fatigue * spatial.fatigueResponse.sideRise;
  down += fatigue * spatial.fatigueResponse.downRise;

  // Negative valence → look down (averted gaze, sadness)
  if (valence < 0) {
    const drag = Math.abs(valence) * 0.5;
    camera -= drag;
    down += drag;
  }

  // Positive valence → eye contact (confidence)
  if (valence > 0) {
    camera += valence * 0.3;
    side -= valence * 0.15;
    down -= valence * 0.15;
  }

  return {
    postureLean: clampRange(spatial.postureLeanBaseline + fatigue * spatial.fatigueResponse.leanGain, -1, 1),
    headTiltBias: spatial.headTiltBias,
    gazeDistribution: {
      camera: Math.max(0, camera),
      side: Math.max(0, side),
      down: Math.max(0, down),
    },
  };
}

function clampRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
