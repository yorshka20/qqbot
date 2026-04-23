import { describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../../state/types';
import { AmbientAudioLayer } from '../AmbientAudioLayer';

// Activity stub — AmbientAudioLayer ignores it, just pass the default.
const IDLE = DEFAULT_ACTIVITY;

describe('AmbientAudioLayer', () => {
  test('empty state returns {}', () => {
    const layer = new AmbientAudioLayer();
    expect(layer.sample(Date.now(), IDLE)).toEqual({});
  });

  test('fresh rms=0.8 emits body.z and brow with correct values', () => {
    // smoothingAlpha=1 so one updateRms applies full RMS (otherwise EMA changes expected math)
    const layer = new AmbientAudioLayer({ smoothingAlpha: 1 });
    const t0 = Date.now();
    layer.updateRms(0.8, t0);
    const result = layer.sample(Date.now(), IDLE);
    const floor = 0.02;
    const normalized = Math.min(1, (0.8 - floor) / (1 - floor));
    const excite = normalized ** 1;
    expect(Object.keys(result).sort()).toEqual(['body.z', 'brow']);
    expect(result['body.z']).toBeCloseTo(0.8 * excite, 3);
    expect(result.brow).toBeCloseTo(0.5 * excite, 3);
  });

  test('silence floor below threshold returns {}', () => {
    const layer = new AmbientAudioLayer({ smoothingAlpha: 1 });
    layer.updateRms(0.01, Date.now());
    expect(layer.sample(Date.now(), IDLE)).toEqual({});
  });

  test('silence floor exact threshold returns {}', () => {
    const layer = new AmbientAudioLayer({ smoothingAlpha: 1 });
    layer.updateRms(0.02, Date.now());
    expect(layer.sample(Date.now(), IDLE)).toEqual({});
  });

  test('staleness: gap > staleThresholdMs returns {}', () => {
    const layer = new AmbientAudioLayer();
    const t0 = Date.now();
    layer.updateRms(0.8, t0);
    // sample at t0 + 600ms > 500ms threshold
    expect(layer.sample(t0 + 600, IDLE)).toEqual({});
  });

  test('staleness boundary at lastSeen + 499 returns non-empty', () => {
    const layer = new AmbientAudioLayer();
    const t0 = Date.now();
    layer.updateRms(0.8, t0);
    // within 500ms window → non-empty
    const result = layer.sample(t0 + 499, IDLE);
    expect(Object.keys(result).sort()).toEqual(['body.z', 'brow']);
  });

  test('staleness boundary at lastSeen + 501 returns {}', () => {
    const layer = new AmbientAudioLayer();
    const t0 = Date.now();
    layer.updateRms(0.8, t0);
    // just past 500ms window → stale
    expect(layer.sample(t0 + 501, IDLE)).toEqual({});
  });

  test('custom options override defaults', () => {
    const layer = new AmbientAudioLayer({ bodyZMax: 0.5, staleThresholdMs: 200, smoothingAlpha: 1 });
    const t0 = Date.now();
    layer.updateRms(0.8, t0);
    const floor = 0.02;
    const normalized = Math.min(1, (0.8 - floor) / (1 - floor));
    const excite = normalized ** 1;
    const result = layer.sample(t0 + 100, IDLE);
    expect(result['body.z']).toBeCloseTo(0.5 * excite, 3);
    expect(result.brow).toBeCloseTo(0.5 * excite, 3);
    expect(layer.sample(t0 + 300, IDLE)).toEqual({});
  });

  test('reset() returns {} after previously populated sample', () => {
    const layer = new AmbientAudioLayer();
    layer.updateRms(0.8, Date.now());
    layer.reset();
    expect(layer.sample(Date.now(), IDLE)).toEqual({});
  });

  test('output keys are strictly subset of {body.z, brow}', () => {
    const layer = new AmbientAudioLayer();
    layer.updateRms(0.8, Date.now());
    // sample at various times to get both stale and non-stale results
    const resultFresh = layer.sample(Date.now(), IDLE);
    const resultStale = layer.sample(Date.now() - 600, IDLE);
    for (const result of [resultFresh, resultStale]) {
      for (const key of Object.keys(result)) {
        expect(key === 'body.z' || key === 'brow').toBe(true);
      }
    }
  });
});
