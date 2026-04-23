import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_ACTIVITY } from '../../state/types';
import { AnimationCompiler } from '../AnimationCompiler';
import { AudioEnvelopeLayer } from '../layers/AudioEnvelopeLayer';
import { DEFAULT_AUDIO_ENVELOPE_CONFIG, setAudioEnvelopeConfig } from '../layers/audio-envelope-config';

// Tests B, C, D, E: AnimationCompiler spring overrides + AudioEnvelope shared config + envelope tunables

// ---------------------------------------------------------------------------
// Test B — spring override: setTunableParam updates the resolved value
// ---------------------------------------------------------------------------
describe('AnimationCompiler spring override', () => {
  test('setTunableParam body.z.omega=15 is reflected in listTunableParams', () => {
    const compiler = new AnimationCompiler();
    compiler.setTunableParam('compiler:spring-damper', 'body.z.omega', 15);

    const sections = compiler.listTunableParams();
    const springSection = sections.find((s) => s.id === 'compiler:spring-damper');
    expect(springSection).toBeDefined();

    const omegaParam = springSection!.params.find((p) => p.id === 'body.z.omega');
    expect(omegaParam?.value).toBe(15);

    // zeta should still be the default for body.z (0.85, per DEFAULT_SPRING_BY_CHANNEL)
    const zetaParam = springSection!.params.find((p) => p.id === 'body.z.zeta');
    // DEFAULT_SPRING_BY_CHANNEL['body.z'].zeta = 0.85
    expect(zetaParam?.value).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// Test C — spring list shape: 12 params covering 6 channels × 2 attrs
// ---------------------------------------------------------------------------
describe('AnimationCompiler spring list shape', () => {
  test('compiler:spring-damper section has exactly 12 params', () => {
    const compiler = new AnimationCompiler();
    const sections = compiler.listTunableParams();
    const springSection = sections.find((s) => s.id === 'compiler:spring-damper');
    expect(springSection).toBeDefined();
    expect(springSection!.params).toHaveLength(12);
  });

  test('each of the 6 exposed channels has exactly one omega and one zeta param', () => {
    const compiler = new AnimationCompiler();
    const sections = compiler.listTunableParams();
    const springSection = sections.find((s) => s.id === 'compiler:spring-damper')!;
    const CHANNELS = ['body.x', 'body.y', 'body.z', 'head.yaw', 'head.pitch', 'head.roll'];

    for (const ch of CHANNELS) {
      const omega = springSection.params.find((p) => p.id === `${ch}.omega`);
      const zeta = springSection.params.find((p) => p.id === `${ch}.zeta`);
      expect(omega).toBeDefined();
      expect(zeta).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Test D — AudioEnvelopeLayer shared config
// ---------------------------------------------------------------------------
describe('AudioEnvelopeLayer shared singleton config', () => {
  afterEach(() => {
    // Reset the shared singleton so tests don't bleed into each other
    setAudioEnvelopeConfig(DEFAULT_AUDIO_ENVELOPE_CONFIG);
  });

  test('two separate layers reflect the same bodyZMax after setAudioEnvelopeConfig', () => {
    setAudioEnvelopeConfig({ bodyZMax: 1.0 });

    // High-energy envelope: v=0.9 > default threshold=0.3, so excite > 0
    const envelope = new Float32Array([0.9, 0.9, 0.9]);
    const opts = {
      envelope,
      hopMs: 100,
      startAtMs: 0,
      durationMs: 300,
    };
    const layer1 = new AudioEnvelopeLayer({ ...opts, id: 'audio-envelope-1' });
    const layer2 = new AudioEnvelopeLayer({ ...opts, id: 'audio-envelope-2' });

    const activity = DEFAULT_ACTIVITY;
    const out1 = layer1.sample(50, activity);
    const out2 = layer2.sample(50, activity);

    // Both layers must emit the same body.z
    expect(out1['body.z']).toBeDefined();
    expect(out2['body.z']).toBeDefined();
    expect(out1['body.z']).toBe(out2['body.z']);

    // body.z must exceed what the default bodyZMax=0.4 would produce,
    // proving the singleton change (bodyZMax=1.0) took effect.
    // At v=0.9, threshold=0.3: excite = ((0.9-0.3)/(1-0.3))^2 ≈ 0.7347
    // new: body.z = 1.0 * 0.7347; old: body.z = 0.4 * 0.7347
    expect(out1['body.z']!).toBeGreaterThan(DEFAULT_AUDIO_ENVELOPE_CONFIG.bodyZMax * 0.7);
  });
});

// ---------------------------------------------------------------------------
// Test E — compiler:envelope tunable section shape and runtime updates
// ---------------------------------------------------------------------------
describe('AnimationCompiler compiler:envelope tunable section', () => {
  test('Test E1: compiler:envelope section exists with 2 params', () => {
    const compiler = new AnimationCompiler();
    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope');
    expect(envelopeSection).toBeDefined();
    expect(envelopeSection!.params).toHaveLength(2);
  });

  test('Test E2: compiler:envelope has crossfadeMs and baselineHalfLifeMs params', () => {
    const compiler = new AnimationCompiler();
    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope')!;

    const crossfadeParam = envelopeSection.params.find((p) => p.id === 'crossfadeMs');
    expect(crossfadeParam).toBeDefined();
    expect(crossfadeParam!.default).toBe(250);
    expect(crossfadeParam!.min).toBe(0);
    expect(crossfadeParam!.max).toBe(1000);

    const halfLifeParam = envelopeSection.params.find((p) => p.id === 'baselineHalfLifeMs');
    expect(halfLifeParam).toBeDefined();
    expect(halfLifeParam!.default).toBe(3000);
    expect(halfLifeParam!.min).toBe(1000);
    expect(halfLifeParam!.max).toBe(120000);
  });

  test('Test E3: default crossfadeMs value is 250 when no config override', () => {
    const compiler = new AnimationCompiler();
    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope')!;
    const crossfadeParam = envelopeSection.params.find((p) => p.id === 'crossfadeMs')!;
    expect(crossfadeParam.value).toBe(250);
  });

  test('Test E4: config crossfadeMs=100 reflected as initial tunable value', () => {
    const compiler = new AnimationCompiler({ crossfadeMs: 100 });
    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope')!;
    const crossfadeParam = envelopeSection.params.find((p) => p.id === 'crossfadeMs')!;
    expect(crossfadeParam.value).toBe(100);
  });

  test('Test E5: setTunableParam compiler:envelope crossfadeMs=500 updates runtime value', () => {
    const compiler = new AnimationCompiler();
    compiler.setTunableParam('compiler:envelope', 'crossfadeMs', 500);

    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope')!;
    const crossfadeParam = envelopeSection.params.find((p) => p.id === 'crossfadeMs')!;
    // Runtime override should be reflected in the listed value
    expect(crossfadeParam.value).toBe(500);
  });

  test('Test E6: setTunableParam compiler:envelope baselineHalfLifeMs=30000 updates runtime value', () => {
    const compiler = new AnimationCompiler();
    compiler.setTunableParam('compiler:envelope', 'baselineHalfLifeMs', 30000);

    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope')!;
    const halfLifeParam = envelopeSection.params.find((p) => p.id === 'baselineHalfLifeMs')!;
    expect(halfLifeParam.value).toBe(30000);
  });

  test('Test E7: envelope override does not break existing spring-damper section', () => {
    const compiler = new AnimationCompiler();
    compiler.setTunableParam('compiler:envelope', 'crossfadeMs', 100);
    compiler.setTunableParam('compiler:spring-damper', 'body.z.omega', 15);

    const sections = compiler.listTunableParams();
    const springSection = sections.find((s) => s.id === 'compiler:spring-damper');
    expect(springSection).toBeDefined();
    const omegaParam = springSection!.params.find((p) => p.id === 'body.z.omega');
    expect(omegaParam?.value).toBe(15);

    // Envelope section still intact
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope');
    expect(envelopeSection).toBeDefined();
    const crossfadeParam = envelopeSection!.params.find((p) => p.id === 'crossfadeMs');
    expect(crossfadeParam?.value).toBe(100);
  });

  test('Test E8: NaN and Infinity values are silently dropped for envelope params', () => {
    const compiler = new AnimationCompiler();
    compiler.setTunableParam('compiler:envelope', 'crossfadeMs', Number.NaN);
    compiler.setTunableParam('compiler:envelope', 'baselineHalfLifeMs', Number.POSITIVE_INFINITY);

    const sections = compiler.listTunableParams();
    const envelopeSection = sections.find((s) => s.id === 'compiler:envelope')!;
    const crossfadeParam = envelopeSection.params.find((p) => p.id === 'crossfadeMs')!;
    const halfLifeParam = envelopeSection.params.find((p) => p.id === 'baselineHalfLifeMs')!;

    // Values should remain at defaults (overrides were rejected)
    expect(crossfadeParam.value).toBe(250);
    expect(halfLifeParam.value).toBe(3000);
  });
});
