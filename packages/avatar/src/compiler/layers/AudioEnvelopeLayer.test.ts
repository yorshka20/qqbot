import { describe, expect, test } from 'bun:test';
import type { BotState } from '../../state/types';
import { AudioEnvelopeLayer } from './AudioEnvelopeLayer';

// Minimal BotState stub — tests don't use state values
const IDLE = 'idle' as unknown as BotState;

describe('AudioEnvelopeLayer', () => {
  const makeLayer = () =>
    new AudioEnvelopeLayer({
      id: 'test-layer',
      envelope: new Float32Array([0, 0.5, 1.0]),
      hopMs: 100,
      startAtMs: 1000,
      durationMs: 300,
    });

  test('before startAtMs returns {}', () => {
    const layer = makeLayer();
    expect(layer.sample(999, IDLE)).toEqual({});
  });

  test('after startAtMs + durationMs returns {}', () => {
    const layer = makeLayer();
    // t = 1301 - 1000 = 301 > 300
    expect(layer.sample(1301, IDLE)).toEqual({});
  });

  test('exact boundary at startAtMs + durationMs (t=300) is included', () => {
    const layer = makeLayer();
    const result = layer.sample(1300, IDLE);
    // t=300, idxF=3.0, i0=3 >= length(3) → {}
    // envelope has length 3 so i0=3 is out of bounds → {}
    expect(result).toEqual({});
  });

  test('exact mid-point returns envelope[1]', () => {
    const layer = makeLayer();
    // t = 1100 - 1000 = 100, idxF = 100/100 = 1, i0=1, frac=0 → envelope[1]=0.5
    const result = layer.sample(1100, IDLE);
    expect(result['mouth.open']).toBeCloseTo(0.5, 5);
  });

  test('interpolation between envelope[1] and envelope[2]', () => {
    const layer = makeLayer();
    // t = 1150 - 1000 = 150, idxF = 1.5, i0=1, i1=2, frac=0.5
    // v = 0.5*(1-0.5) + 1.0*0.5 = 0.25 + 0.5 = 0.75
    const result = layer.sample(1150, IDLE);
    expect(result['mouth.open']).toBeCloseTo(0.75, 5);
  });

  test('empty envelope always returns {}', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'empty',
      envelope: new Float32Array(0),
      hopMs: 100,
      startAtMs: 0,
      durationMs: 10000,
    });
    expect(layer.sample(500, IDLE)).toEqual({});
    expect(layer.sample(0, IDLE)).toEqual({});
    expect(layer.sample(9999, IDLE)).toEqual({});
  });

  test('BaseLayer compatibility: default weight=1.0, isEnabled=true', () => {
    const layer = makeLayer();
    expect(layer.getWeight()).toBe(1.0);
    expect(layer.isEnabled()).toBe(true);
  });

  test('BaseLayer setEnabled toggles isEnabled', () => {
    const layer = makeLayer();
    layer.setEnabled(false);
    expect(layer.isEnabled()).toBe(false);
    layer.setEnabled(true);
    expect(layer.isEnabled()).toBe(true);
  });

  test('custom weight applied via constructor', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'weighted',
      envelope: new Float32Array([0.5]),
      hopMs: 100,
      startAtMs: 0,
      durationMs: 200,
      weight: 0.42,
    });
    expect(layer.getWeight()).toBeCloseTo(0.42, 5);
  });
});
