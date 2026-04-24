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
    const base = compiler.getActionDuration('smile');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
    const base = compiler.getActionDuration('smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
    const base = compiler.getActionDuration('smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.8 });
    const node = (spy.mock.calls[0][0] as Array<{ duration: number; intensity: number }>)[0];
    expect(node.intensity).toBeCloseTo(0.4, 5);
  });

  test('perCategoryScale multiplies with global intensityScale', () => {
    const compiler = (s as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0);
    // smile is category=emotion in default-action-map.json
    withProvider(s, {
      amplitude: {
        intensityScale: 0.8,
        perCategoryScale: { emotion: 0.5 },
      },
      timing: { speedScale: 1.0 },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 1.0 });
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
    const base = compiler.getActionDuration('smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
    const base = compiler.getActionDuration('smile');
    const spy = spyOn(compiler, 'enqueue');
    for (let i = 0; i < 20; i++) {
      s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
    const base = compiler.getActionDuration('smile');
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
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
      actionPref: { variantWeights: { smile: weights } },
    });
    const spy = spyOn(compiler, 'enqueue');
    s.enqueueTagAnimation({ action: 'smile', emotion: 'happy', intensity: 0.5 });
    const node = (spy.mock.calls[0][0] as Array<{ variantWeights?: readonly number[] }>)[0];
    expect(node.variantWeights).toBe(weights);
  });
});
