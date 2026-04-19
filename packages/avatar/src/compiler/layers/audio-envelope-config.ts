/**
 * Shared, live-editable config for AudioEnvelopeLayer. Every active
 * utterance layer reads from this module each sample tick, so slider
 * drags take effect immediately — even mid-utterance.
 *
 * Defaults mirror the module-scope constants previously in
 * AudioEnvelopeLayer.ts (EXCITE_THRESHOLD=0.3, EXCITE_POWER=2,
 * BODY_Z_MAX=0.4, EYE_OPEN_MAX=0.15, BROW_MAX=0.3).
 */
export interface AudioEnvelopeConfig {
  threshold: number;
  power: number;
  bodyZMax: number;
  eyeOpenMax: number;
  browMax: number;
}

export const DEFAULT_AUDIO_ENVELOPE_CONFIG: AudioEnvelopeConfig = {
  threshold: 0.3,
  power: 2,
  bodyZMax: 0.4,
  eyeOpenMax: 0.15,
  browMax: 0.3,
};

const state: AudioEnvelopeConfig = { ...DEFAULT_AUDIO_ENVELOPE_CONFIG };

export function getAudioEnvelopeConfig(): Readonly<AudioEnvelopeConfig> {
  return state;
}

export function setAudioEnvelopeConfig(patch: Partial<AudioEnvelopeConfig>): void {
  for (const k of Object.keys(patch) as (keyof AudioEnvelopeConfig)[]) {
    const v = patch[k];
    if (typeof v === 'number' && Number.isFinite(v)) state[k] = v;
  }
}
