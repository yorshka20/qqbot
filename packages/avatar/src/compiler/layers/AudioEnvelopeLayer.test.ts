import { describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../state/types';
import { AudioEnvelopeLayer } from './AudioEnvelopeLayer';

// Activity stub — AudioEnvelopeLayer ignores it, just pass the default.
const IDLE = DEFAULT_ACTIVITY;

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

describe('energy-driven channels', () => {
  test('envelope below threshold emits only mouth.open', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'quiet',
      envelope: new Float32Array([0.2, 0.2, 0.2]),
      hopMs: 100,
      startAtMs: 0,
      durationMs: 300,
    });
    const result = layer.sample(100, IDLE);
    expect(Object.keys(result).sort()).toEqual(['mouth.open']);
    expect(result['mouth.open']).toBeCloseTo(0.2, 5);
  });

  test('envelope above threshold emits all five channels with correct ratios', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'loud',
      envelope: new Float32Array([0.95, 0.95, 0.95]),
      hopMs: 100,
      startAtMs: 0,
      durationMs: 300,
    });
    const result = layer.sample(100, IDLE);
    const expectedExcite = ((0.95 - 0.3) / 0.7) ** 2;
    expect(Object.keys(result).sort()).toEqual(
      ['body.z', 'brow', 'eye.open.left', 'eye.open.right', 'mouth.open'].sort(),
    );
    expect(result['mouth.open']).toBeCloseTo(0.95, 5);
    expect(result['body.z']).toBeCloseTo(0.4 * expectedExcite, 5);
    expect(result['eye.open.left']).toBeCloseTo(0.15 * expectedExcite, 5);
    expect(result['eye.open.right']).toBeCloseTo(0.15 * expectedExcite, 5);
    expect(result['eye.open.left']).toBe(result['eye.open.right']);
    expect(result.brow).toBeCloseTo(0.3 * expectedExcite, 5);
  });

  test('time-boundary behavior preserved after channel extension', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'boundary',
      envelope: new Float32Array([0, 0.5, 1.0]),
      hopMs: 100,
      startAtMs: 1000,
      durationMs: 300,
    });
    expect(layer.sample(999, IDLE)).toEqual({});
    expect(layer.sample(1301, IDLE)).toEqual({});
  });

  test('mouth.open linear mapping is bit-exact after extension', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'parity',
      envelope: new Float32Array([0, 0.5, 1.0]),
      hopMs: 100,
      startAtMs: 0,
      durationMs: 300,
    });
    // t=150 → idxF=1.5 → interpolate 0.5 and 1.0 with frac=0.5 → 0.75
    const result = layer.sample(150, IDLE);
    expect(result['mouth.open']).toBeCloseTo(0.75, 9);
  });
});

describe('AudioEnvelopeLayer streaming mode', () => {
  test('construct without envelope, sample after start with no frames returns {}', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-empty',
      hopMs: 100,
      startAtMs: 1000,
      durationMs: 5000,
    });
    expect(layer.sample(1050, IDLE)).toEqual({});
    expect(layer.sample(1500, IDLE)).toEqual({});
  });

  test('appendFrames([0.3, 0.5]) then sampling within those hops yields non-zero mouth.open', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-frames',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 5000,
    });
    layer.appendFrames(new Float32Array([0.3, 0.5]));
    // t=0 → i0=0 → v=0.3
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0.3, 5);
    // t=100 → i0=1 → v=0.5
    expect(layer.sample(100, IDLE)['mouth.open']).toBeCloseTo(0.5, 5);
  });

  test('sampling past written frames but before durationMs returns {}', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-ahead',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 5000,
    });
    layer.appendFrames(new Float32Array([0.4])); // only 1 frame (covers 0–100ms)
    // t=500 → i0=5 ≥ envelopeLength(1) → {}
    expect(layer.sample(500, IDLE)).toEqual({});
  });

  test('finalize(durationMs) then sampling after exact end returns {}', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-finalized',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 0, // placeholder
    });
    layer.appendFrames(new Float32Array([0.5, 0.5, 0.5]));
    layer.finalize(300);
    // t = 301 > 300 → {}
    expect(layer.sample(301, IDLE)).toEqual({});
    // t = 300 is the boundary: i0=3 ≥ length(3) → {}
    expect(layer.sample(300, IDLE)).toEqual({});
    // t = 250 → inside range
    const result = layer.sample(250, IDLE);
    expect(result['mouth.open']).toBeGreaterThan(0);
  });

  test('appendFrames beyond initial capacity causes geometric growth without data loss', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-grow',
      hopMs: 10,
      startAtMs: 0,
      durationMs: 100000,
    });

    // Push 200 frames (> initial capacity of 64)
    const count = 200;
    const frames = new Float32Array(count);
    for (let i = 0; i < count; i++) frames[i] = (i % 10) / 10;
    layer.appendFrames(frames);

    // Verify first and last frames are preserved
    // t=0 → i0=0 → frames[0]=0
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0, 9);
    // t=10*(count-1) → i0=199 → frames[199]=9/10=0.9
    expect(layer.sample(10 * (count - 1), IDLE)['mouth.open']).toBeCloseTo(frames[count - 1], 5);
  });

  test('appendFrames on non-streaming layer throws', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'non-streaming',
      envelope: new Float32Array([0.1, 0.2]),
      hopMs: 100,
      startAtMs: 0,
      durationMs: 200,
    });
    expect(() => layer.appendFrames(new Float32Array([0.3]))).toThrow(/non-streaming/);
  });

  test('existing non-streaming behavior preserved bit-for-bit', () => {
    const envelope = new Float32Array([0, 0.5, 1.0]);
    const layer = new AudioEnvelopeLayer({
      id: 'compat',
      envelope,
      hopMs: 100,
      startAtMs: 1000,
      durationMs: 300,
    });
    expect(layer.sample(999, IDLE)).toEqual({});
    expect(layer.sample(1301, IDLE)).toEqual({});
    expect(layer.sample(1100, IDLE)['mouth.open']).toBeCloseTo(0.5, 9);
    expect(layer.sample(1150, IDLE)['mouth.open']).toBeCloseTo(0.75, 9);
  });
});
