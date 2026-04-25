import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';

describe('AvatarService.enqueueTagAnimation — jitter application', () => {
  let service: AvatarService;

  beforeEach(async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 60, outputFps: 60 },
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  test('duration jitter keeps duration in [registered*0.85, registered*1.15] (default ±15%)', () => {
    const compiler = (service as any).compiler;
    expect(compiler).not.toBeNull();
    const enqueueSpy = spyOn(compiler, 'enqueue');
    const base = compiler.getActionDuration('emotion_smile'); // exists in core-action-map.json
    expect(base).toBeGreaterThan(0);

    for (let i = 0; i < 100; i++) {
      service.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    }
    expect(enqueueSpy).toHaveBeenCalledTimes(100);
    for (const call of enqueueSpy.mock.calls) {
      const nodes = call[0] as Array<{ duration: number; intensity: number }>;
      expect(nodes).toHaveLength(1);
      expect(nodes[0].duration).toBeGreaterThanOrEqual(Math.floor(base * 0.85));
      expect(nodes[0].duration).toBeLessThanOrEqual(Math.ceil(base * 1.15));
    }
  });

  test('intensity jitter keeps intensity in [0.45, 0.55] for base=0.5 (default ±10%, floor 0.1)', () => {
    const compiler = (service as any).compiler;
    const enqueueSpy = spyOn(compiler, 'enqueue');

    for (let i = 0; i < 100; i++) {
      service.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    }
    for (const call of enqueueSpy.mock.calls) {
      const nodes = call[0] as Array<{ duration: number; intensity: number }>;
      expect(nodes[0].intensity).toBeGreaterThanOrEqual(0.45 - 1e-9);
      expect(nodes[0].intensity).toBeLessThanOrEqual(0.55 + 1e-9);
    }
  });

  test('intensityFloor clamps low intensities even with aggressive jitter', () => {
    const compiler = (service as any).compiler;
    // Bump jitter to 0.5 so intensity=0.2 could dip below 0.1 without floor.
    compiler.setTunableParam('compiler:jitter', 'intensityJitter', 0.5);
    const enqueueSpy = spyOn(compiler, 'enqueue');

    for (let i = 0; i < 200; i++) {
      service.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.2 });
    }
    for (const call of enqueueSpy.mock.calls) {
      const nodes = call[0] as Array<{ duration: number; intensity: number }>;
      expect(nodes[0].intensity).toBeGreaterThanOrEqual(0.1 - 1e-9);
    }
  });

  test('HUD tunable durationJitter=0 produces deterministic registered duration', () => {
    const compiler = (service as any).compiler;
    compiler.setTunableParam('compiler:jitter', 'durationJitter', 0);
    const enqueueSpy = spyOn(compiler, 'enqueue');
    const base = compiler.getActionDuration('emotion_smile');

    for (let i = 0; i < 10; i++) {
      service.enqueueTagAnimation({ action: 'emotion_smile', emotion: 'happy', intensity: 0.5 });
    }
    for (const call of enqueueSpy.mock.calls) {
      const nodes = call[0] as Array<{ duration: number; intensity: number }>;
      expect(nodes[0].duration).toBe(base);
    }
  });
});
