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

  test('appendFrames([0.3, 0.5]) normalizes to running peak (0.5) scaled to 0.95', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-frames',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 5000,
    });
    layer.appendFrames(new Float32Array([0.3, 0.5]));
    // Streaming mode normalizes: raw / peak * 0.95. peak=0.5.
    // t=0 → raw=0.3 → 0.3/0.5*0.95 = 0.57
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0.57, 5);
    // t=100 → raw=0.5 → 0.5/0.5*0.95 = 0.95
    expect(layer.sample(100, IDLE)['mouth.open']).toBeCloseTo(0.95, 5);
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

    // Verify first and last frames are preserved (after streaming
    // normalization). peak across frames = max((i%10)/10 for i<200) = 0.9.
    // t=0 → i0=0 → raw=0 → normalized=0
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0, 9);
    // t=10*(count-1) → i0=199 → raw=0.9 → 0.9/0.9*0.95 = 0.95
    expect(layer.sample(10 * (count - 1), IDLE)['mouth.open']).toBeCloseTo(0.95, 5);
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

  test('quiet speech still reaches peak amplitude (0.95) on its loudest frame', () => {
    // Simulates the real bug: unnormalized Sovits RMS peaks around 0.2–0.3
    // so mouth.open never exceeds ~0.3 without streaming normalization.
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-quiet',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 5000,
    });
    layer.appendFrames(new Float32Array([0.05, 0.1, 0.2, 0.15, 0.1]));
    // peak = 0.2 → loudest frame maps to 0.95, not 0.2.
    expect(layer.sample(200, IDLE)['mouth.open']).toBeCloseTo(0.95, 5);
    // And quieter frames scale proportionally — 0.05/0.2*0.95 = 0.2375.
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0.2375, 5);
  });

  test('peak follower rises monotonically and retroactively rescales earlier frames', () => {
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-retro',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 5000,
    });
    // First batch: peak becomes 0.2 after append. 0.1/0.2*0.95 = 0.475.
    layer.appendFrames(new Float32Array([0.1, 0.2]));
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0.475, 5);

    // Second batch adds a louder frame; peak becomes 0.5.
    // The earlier 0.1 frame is now rescaled against the new peak:
    // 0.1/0.5*0.95 = 0.19. This is the "retroactive rescale" contract.
    layer.appendFrames(new Float32Array([0.5]));
    expect(layer.sample(0, IDLE)['mouth.open']).toBeCloseTo(0.19, 5);
    expect(layer.sample(200, IDLE)['mouth.open']).toBeCloseTo(0.95, 5);
  });

  test('excite-driven channels also benefit from streaming normalization', () => {
    // Raw 0.3 would be below threshold (0.3) and emit only mouth.open.
    // After normalization (peak=0.3, scale to 0.95), v=0.95 clears threshold
    // and excites body.z / eye.open / brow. This fixes "quiet speech →
    // lifeless avatar" for streaming utterances specifically.
    const layer = new AudioEnvelopeLayer({
      id: 'streaming-excite',
      hopMs: 100,
      startAtMs: 0,
      durationMs: 5000,
    });
    layer.appendFrames(new Float32Array([0.2, 0.3])); // peak = 0.3

    const result = layer.sample(100, IDLE);
    expect(result['mouth.open']).toBeCloseTo(0.95, 5);
    expect(result['body.z']).toBeGreaterThan(0);
    expect(result['eye.open.left']).toBeGreaterThan(0);
    expect(result['eye.open.right']).toBeGreaterThan(0);
    expect(result.brow).toBeGreaterThan(0);
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
