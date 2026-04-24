import { describe, expect, test } from 'bun:test';
import { applyStimulus, deriveModulation, derivePersonaPostureBias, freshPhenotype, tickPhenotype } from '../ode';
import { DEFAULT_MIND_CONFIG, type MindConfig } from '../types';

function config(overrides: Partial<MindConfig> = {}): MindConfig {
  return { ...DEFAULT_MIND_CONFIG, ...overrides, enabled: true };
}

describe('freshPhenotype', () => {
  test('starts at zero', () => {
    const p = freshPhenotype();
    expect(p.fatigue).toBe(0);
    expect(p.attention).toBe(0);
    expect(p.stimulusCount).toBe(0);
    expect(p.lastStimulusAt).toBeUndefined();
  });
});

describe('tickPhenotype', () => {
  test('fatigue accrues linearly while active', () => {
    const cfg = config();
    const p = tickPhenotype(freshPhenotype(), 60_000, true, cfg);
    expect(p.fatigue).toBeCloseTo(60_000 * cfg.ode.fatigueAccrualPerMs, 6);
  });

  test('fatigue decays while idle', () => {
    const cfg = config();
    const seeded = { ...freshPhenotype(), fatigue: 0.5 };
    const p = tickPhenotype(seeded, 60_000, false, cfg);
    expect(p.fatigue).toBeLessThan(0.5);
  });

  test('fatigue clamps to [0,1]', () => {
    const cfg = config();
    // 10M ms active → would blow past 1 without clamp
    const p = tickPhenotype(freshPhenotype(), 10_000_000, true, cfg);
    expect(p.fatigue).toBe(1);
    // Idle from 0 → can't go negative
    const q = tickPhenotype(freshPhenotype(), 10_000_000, false, cfg);
    expect(q.fatigue).toBe(0);
  });

  test('attention decays exponentially', () => {
    const cfg = config();
    const seeded = { ...freshPhenotype(), attention: 1 };
    // τ = 120_000 ms; after one τ attention should be 1/e ≈ 0.368
    const p = tickPhenotype(seeded, cfg.ode.tauAttentionMs, false, cfg);
    expect(p.attention).toBeCloseTo(Math.exp(-1), 3);
  });

  test('zero dtMs is a no-op', () => {
    const cfg = config();
    const seeded = { ...freshPhenotype(), fatigue: 0.3, attention: 0.5 };
    const p = tickPhenotype(seeded, 0, true, cfg);
    expect(p).toBe(seeded);
  });

  test('negative dtMs is a no-op (clock skew)', () => {
    const cfg = config();
    const seeded = { ...freshPhenotype(), fatigue: 0.3 };
    const p = tickPhenotype(seeded, -1000, true, cfg);
    expect(p).toBe(seeded);
  });
});

describe('applyStimulus', () => {
  test('message stimulus spikes attention + increments count', () => {
    const cfg = config();
    const p = applyStimulus(freshPhenotype(), { kind: 'message', ts: 100 }, cfg);
    expect(p.attention).toBeCloseTo(cfg.ode.attentionSpikePerMessage, 6);
    expect(p.stimulusCount).toBe(1);
    expect(p.lastStimulusAt).toBe(100);
  });

  test('attention spike clamps to 1', () => {
    const cfg = config({ ode: { ...DEFAULT_MIND_CONFIG.ode, attentionSpikePerMessage: 0.9 } });
    let p = freshPhenotype();
    for (let i = 0; i < 5; i++) {
      p = applyStimulus(p, { kind: 'message', ts: i }, cfg);
    }
    expect(p.attention).toBe(1);
    expect(p.stimulusCount).toBe(5);
  });

  test('fatigue is untouched by a message stimulus', () => {
    const cfg = config();
    const seeded = { ...freshPhenotype(), fatigue: 0.42 };
    const p = applyStimulus(seeded, { kind: 'message', ts: 0 }, cfg);
    expect(p.fatigue).toBe(0.42);
  });
});

describe('deriveModulation', () => {
  test('zero fatigue → identity modulation', () => {
    const cfg = config();
    const m = deriveModulation(freshPhenotype(), cfg);
    expect(m.intensityScale).toBe(1);
    expect(m.speedScale).toBe(1);
    expect(m.durationBias).toBe(0);
  });

  test('max fatigue drops intensity + speed by configured amount', () => {
    const cfg = config();
    const p = { ...freshPhenotype(), fatigue: 1 };
    const m = deriveModulation(p, cfg);
    expect(m.intensityScale).toBeCloseTo(1 - cfg.modulation.fatigueIntensityDrop, 6);
    expect(m.speedScale).toBeCloseTo(1 - cfg.modulation.fatigueSpeedDrop, 6);
  });

  test('half fatigue halves the drop', () => {
    const cfg = config();
    const p = { ...freshPhenotype(), fatigue: 0.5 };
    const m = deriveModulation(p, cfg);
    expect(m.intensityScale).toBeCloseTo(1 - 0.5 * cfg.modulation.fatigueIntensityDrop, 6);
  });
});

describe('derivePersonaPostureBias', () => {
  test('fatigue=0 → subtle baseline (visible but small)', () => {
    const bias = derivePersonaPostureBias(freshPhenotype());
    expect(bias.postureLean).toBeCloseTo(0.08, 6);
    expect(bias.headTiltBias).toBe(0);
    expect(bias.gazeContactPreference).toBeCloseTo(0.6, 6);
  });

  test('high fatigue amplifies lean, suppresses gaze contact', () => {
    const bias = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: 1 });
    expect(bias.postureLean).toBeGreaterThan(0.08);
    expect(bias.gazeContactPreference).toBeLessThan(0.6);
  });

  test('outputs stay in documented ranges', () => {
    for (const f of [-1, 0, 0.3, 0.7, 1, 2]) {
      const bias = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: f });
      expect(bias.postureLean).toBeGreaterThanOrEqual(-1);
      expect(bias.postureLean).toBeLessThanOrEqual(1);
      expect(bias.gazeContactPreference).toBeGreaterThanOrEqual(0);
      expect(bias.gazeContactPreference).toBeLessThanOrEqual(1);
    }
  });

  test('monotonic: higher fatigue ⇒ larger lean, lower gaze', () => {
    const low = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: 0.2 });
    const high = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: 0.8 });
    expect(high.postureLean).toBeGreaterThan(low.postureLean);
    expect(high.gazeContactPreference).toBeLessThan(low.gazeContactPreference);
  });
});
