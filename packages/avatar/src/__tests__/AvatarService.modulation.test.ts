import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { MindModulation, MindModulationProvider } from '../mind/types';

function service(): Promise<AvatarService> {
  const s = new AvatarService();
  return s
    .initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 60, outputFps: 60 },
    })
    .then(() => s);
}

function withProvider(s: AvatarService, modulation: MindModulation): void {
  const provider: MindModulationProvider = { getModulation: () => modulation };
  s.setMindModulationProvider(provider);
}

describe('AvatarService.enqueueTagAnimation — persona modulation', () => {
  let s: AvatarService;

  beforeEach(async () => {
    s = await service();
  });

  afterEach(async () => {
    await s.stop();
  });

  test('no provider → identity modulation, behavior unchanged', () => {
    const compiler = (s as any).compiler;
    // Freeze jitter so we observe only modulation (none here).
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    const spy = spyOn(compiler, 'enqueue');
    const base = compiler.getActionDuration('emotion_smile');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.duration).toBe(base);
    expect(node.intensity).toBe(0.5);
  });

  test('speedScale=2 halves duration', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 2.0 },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.duration).toBe(Math.round(base / 2));
  });

  test('speedScale=0.5 doubles duration', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 0.5 },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.duration).toBe(Math.round(base * 2));
  });

  test('intensityScale=0.5 halves intensity', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 0.5 },
      timing: { speedScale: 1.0 },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.8 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.intensity).toBeCloseTo(0.4, 5);
  });

  test('perCategoryScale multiplies with global intensityScale', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    // smile is category=emotion in core-action-map.json
    withProvider(s, {
      amplitude: {
        intensityScale: 0.8,
        perCategoryScale: { emotion: 0.5 },
      },
      timing: { speedScale: 1.0 },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 1.0 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    // 1.0 × 0.8 × 0.5 = 0.4
    expect(node.intensity).toBeCloseTo(0.4, 5);
  });

  test('durationBias adds absolute ms offset', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 1.0, durationBias: 300 },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.duration).toBe(base + 300);
  });

  test('jitterScale=0 produces deterministic output even with default jitter', () => {
    const compiler = (s as any).compiler;
    // Do NOT zero HUD jitter — prove jitterScale takes it down to 0.
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 1.0, jitterScale: 0 },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    for (let i = 0; i < 20; i++) {
      s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    }
    for (const call of spy.mock.calls) {
      const node = (call[0] as Array<{ duration: number; intensity: number }>)[0];
      expect(node.duration).toBe(base);
      expect(node.intensity).toBe(0.5);
    }
  });

  test('negative/NaN scales are sanitized and do not break', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: -1 },
      timing: { speedScale: Number.NaN },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(Number.isFinite(node.duration)).toBe(true);
    expect(node.duration).toBeGreaterThan(0);
    expect(Number.isFinite(node.intensity)).toBe(true);
  });

  test('clearing the provider restores identity behaviour', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 0.5 },
      timing: { speedScale: 2.0 },
    });
    s.setMindModulationProvider(undefined);
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.duration).toBe(base);
    expect(node.intensity).toBe(0.5);
  });

  test('variantWeights flow through on StateNode', () => {
    const compiler = (s as any).compiler;
    const weights = [1, 0, 0];
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 1.0 },
      actionPref: { variantWeights: { emotion_smile: weights } },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ variantWeights?: readonly number[] }>)[0];
    expect(node.variantWeights).toBe(weights);
  });

  // ── Regression: autonomous path must also receive persona modulation ───────
  test('enqueueAutonomous — speedScale=2 halves duration (same pipeline as LLM)', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 1.0 },
      timing: { speedScale: 2.0 },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.5);
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; source: string }>)[0];
    // Duration halved by speedScale=2, same math as enqueueTagAnimation.
    expect(node.duration).toBe(Math.round(base / 2));
    // Source marker confirms the node is autonomous, not llm.
    expect(node.source).toBe('autonomous');
  });

  test('enqueueAutonomous — intensityScale=0.5 halves intensity (same pipeline as LLM)', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    withProvider(s, {
      amplitude: { intensityScale: 0.5 },
      timing: { speedScale: 1.0 },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueAutonomous('emotion_smile', 0.8);
    const node = (spy.mock.calls[0][0] as Array<{ intensity: number }>)[0];
    expect(node.intensity).toBeCloseTo(0.4, 5);
  });

  // ── Tone delta: verify the MindModulationAdapter tone-composition path ────

  test('tone delta: playful modulationDelta (1.1 intensityScale, 1.1 speedScale, -20ms bias) composed with phenotype', () => {
    // Simulate what MindModulationAdapter.getModulation produces for playful tone:
    //   phenotype intensityScale=1.0, speedScale=1.0, durationBias=0
    //   tone delta: intensityScale=1.1, speedScale=1.1, durationBias=-20
    //   → combined intensityScale=1.0*1.1=1.1 (capped at 1.0 by AvatarService), speedScale=1.1, durationBias=-20
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    const playfulDelta = { intensityScale: 1.1, speedScale: 1.1, durationBias: -20 };
    withProvider(s, {
      amplitude: { intensityScale: playfulDelta.intensityScale },
      timing: { speedScale: playfulDelta.speedScale, durationBias: playfulDelta.durationBias },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    // speedScale=1.1 → duration = round(base / 1.1) + bias(-20)
    const expectedDuration = Math.round(base / playfulDelta.speedScale) + playfulDelta.durationBias;
    expect(node.duration).toBe(expectedDuration);
  });

  test('tone delta: weary modulationDelta (0.75 intensityScale, 0.8 speedScale, +80ms bias) composed with phenotype', () => {
    // Weary: slower, lower intensity, longer duration
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    const wearyDelta = { intensityScale: 0.75, speedScale: 0.8, durationBias: 80 };
    withProvider(s, {
      amplitude: { intensityScale: wearyDelta.intensityScale },
      timing: { speedScale: wearyDelta.speedScale, durationBias: wearyDelta.durationBias },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 1.0 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    // speedScale=0.8 → slower → longer duration; +80ms bias
    const expectedDuration = Math.round(base / wearyDelta.speedScale) + wearyDelta.durationBias;
    expect(node.duration).toBe(expectedDuration);
    // intensity reduced by 0.75
    expect(node.intensity).toBeCloseTo(1.0 * wearyDelta.intensityScale, 5);
  });

  test('tone delta: excited modulationDelta (1.25 intensityScale, 1.2 speedScale, -30ms bias)', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    const excitedDelta = { intensityScale: 1.25, speedScale: 1.2, durationBias: -30 };
    withProvider(s, {
      amplitude: { intensityScale: excitedDelta.intensityScale },
      timing: { speedScale: excitedDelta.speedScale, durationBias: excitedDelta.durationBias },
    });
    const base = compiler.getActionDuration('emotion_smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.6 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    const expectedDuration = Math.round(base / excitedDelta.speedScale) + excitedDelta.durationBias;
    expect(node.duration).toBe(expectedDuration);
  });
});
