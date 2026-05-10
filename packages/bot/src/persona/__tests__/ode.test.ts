import { describe, expect, test } from 'bun:test';
import { DEFAULT_CORE_DNA } from '../data/CoreDNALoader';
import { applyStimulus, deriveModulation, derivePersonaPostureBias, freshPhenotype, tickPhenotype } from '../ode';
import { DEFAULT_PERSONA_CONFIG, type PersonaConfig } from '../types';

const DEFAULT_SPATIAL = DEFAULT_CORE_DNA.modulation.spatial;

function config(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return { ...DEFAULT_PERSONA_CONFIG, ...overrides, enabled: true };
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
    const cfg = config({ ode: { ...DEFAULT_PERSONA_CONFIG.ode, attentionSpikePerMessage: 0.9 } });
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
  type PhenotypeWithValence = ReturnType<typeof freshPhenotype> & { valence?: number };

  test('fatigue=0, valence=0 → camera ≥ 0.5 and down is smallest weight', () => {
    const bias = derivePersonaPostureBias(freshPhenotype(), DEFAULT_SPATIAL);
    const d = bias.gazeDistribution ?? {};
    expect(d.camera ?? 0).toBeGreaterThanOrEqual(0.5);
    expect(d.down ?? 0).toBeLessThanOrEqual(d.camera ?? 0);
    expect(d.down ?? 0).toBeLessThanOrEqual(d.side ?? 0);
  });

  test('fatigue=1, valence=0 → camera < 0.3 and side+down > baseline', () => {
    const bias = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: 1 } as PhenotypeWithValence, DEFAULT_SPATIAL);
    const d = bias.gazeDistribution ?? {};
    expect(d.camera ?? 0).toBeLessThan(0.3);
    expect((d.side ?? 0) + (d.down ?? 0)).toBeGreaterThan(0.4);
  });

  test('fatigue=0, valence=-0.6 → down > camera', () => {
    const p = { ...freshPhenotype(), valence: -0.6 } as PhenotypeWithValence;
    const bias = derivePersonaPostureBias(p as ReturnType<typeof freshPhenotype>, DEFAULT_SPATIAL);
    const d = bias.gazeDistribution ?? {};
    expect(d.down ?? 0).toBeGreaterThan(d.camera ?? 0);
  });

  test('fatigue=0, valence=+0.8 → camera is the largest weight and >= 0.7', () => {
    const p = { ...freshPhenotype(), valence: 0.8 } as PhenotypeWithValence;
    const bias = derivePersonaPostureBias(p as ReturnType<typeof freshPhenotype>, DEFAULT_SPATIAL);
    const d = bias.gazeDistribution ?? {};
    expect(d.camera ?? 0).toBeGreaterThanOrEqual(0.7);
    expect(d.camera ?? 0).toBeGreaterThanOrEqual(d.side ?? 0);
    expect(d.camera ?? 0).toBeGreaterThanOrEqual(d.down ?? 0);
  });

  test('all weights non-negative across fatigue × valence grid', () => {
    for (const fatigue of [0, 0.5, 1]) {
      for (const valence of [-1, 0, 1]) {
        const p = { ...freshPhenotype(), fatigue, valence } as PhenotypeWithValence;
        const bias = derivePersonaPostureBias(p as ReturnType<typeof freshPhenotype>, DEFAULT_SPATIAL);
        const d = bias.gazeDistribution ?? {};
        expect(d.camera ?? 0).toBeGreaterThanOrEqual(0);
        expect(d.side ?? 0).toBeGreaterThanOrEqual(0);
        expect(d.down ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('postureLean stays in [-1, 1]', () => {
    for (const fatigue of [0, 0.5, 1]) {
      const bias = derivePersonaPostureBias({ ...freshPhenotype(), fatigue }, DEFAULT_SPATIAL);
      expect(bias.postureLean ?? 0).toBeGreaterThanOrEqual(-1);
      expect(bias.postureLean ?? 0).toBeLessThanOrEqual(1);
    }
  });

  test('high fatigue amplifies lean', () => {
    const low = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: 0.2 }, DEFAULT_SPATIAL);
    const high = derivePersonaPostureBias({ ...freshPhenotype(), fatigue: 0.8 }, DEFAULT_SPATIAL);
    expect(high.postureLean ?? 0).toBeGreaterThan(low.postureLean ?? 0);
  });
});
