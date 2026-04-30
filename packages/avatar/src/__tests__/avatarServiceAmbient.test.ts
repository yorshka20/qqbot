import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';

async function service(): Promise<AvatarService> {
  const s = new AvatarService();
  await s.initialize({
    enabled: true,
    vts: { enabled: false },
    preview: { enabled: false },
    speech: { enabled: false },
    compiler: { fps: 60, outputFps: 60 },
  });
  return s;
}

describe('AvatarService ambient gain bus integration', () => {
  let s: AvatarService;

  beforeEach(async () => {
    s = await service();
  });

  afterEach(async () => {
    await s.stop();
  });

  test('single source via setActivity converges toward 0.3', () => {
    const compiler = (s as any).compiler;
    const spy = spyOn(compiler, 'setActivity');

    // Set up a stub previewServer so runStatusTick doesn't return early.
    (s as any).previewServer = { updateStatus: () => {} };

    // Set activity with ambientGain=0.3
    s.setActivity({ ambientGain: 0.3 });

    // The immediate setActivity call should reflect current bus value (still ~1.0).
    const firstCall = spy.mock.calls[spy.mock.calls.length - 1] as [any];
    expect(firstCall[0].ambientGain).toBe(1.0);

    // Run 10 status ticks (each drives bus.tick(1000)).
    for (let i = 0; i < 10; i++) {
      (s as any).runStatusTick();
    }

    // The last setActivity call should have ambientGain close to 0.3.
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1] as [any];
    expect(Math.abs(lastCall[0].ambientGain - 0.3)).toBeLessThan(0.02);

    // Verify monotonic decrease across all calls.
    let prev: number | null = null;
    for (const call of spy.mock.calls) {
      const val = (call as [any])[0].ambientGain;
      if (prev !== null) {
        expect(val).toBeLessThanOrEqual(prev + 1e-9);
      }
      prev = val;
    }
  });

  test('multi-source min: setActivity(0.3) + setAmbientGainSource(mind, 0.5) → converges to 0.3', () => {
    const compiler = (s as any).compiler;
    (s as any).previewServer = { updateStatus: () => {} };
    const spy = spyOn(compiler, 'setActivity');

    s.setActivity({ ambientGain: 0.3 });
    s.setAmbientGainSource('persona', 0.5);

    for (let i = 0; i < 10; i++) {
      (s as any).runStatusTick();
    }

    const lastCall = spy.mock.calls[spy.mock.calls.length - 1] as [any];
    expect(Math.abs(lastCall[0].ambientGain - 0.3)).toBeLessThan(0.02);
  });

  test('clearSource: after clearing activity, mind-only source converges to 0.5', () => {
    const compiler = (s as any).compiler;
    (s as any).previewServer = { updateStatus: () => {} };
    const spy = spyOn(compiler, 'setActivity');

    // Set both sources
    s.setActivity({ ambientGain: 0.3 });
    s.setAmbientGainSource('persona', 0.5);

    // Converge to 0.3
    for (let i = 0; i < 10; i++) {
      (s as any).runStatusTick();
    }

    const beforeClear = spy.mock.calls[spy.mock.calls.length - 1] as [any];
    expect(Math.abs(beforeClear[0].ambientGain - 0.3)).toBeLessThan(0.02);

    // Clear activity → mind (0.5) reasserts
    s.clearAmbientGainSource('activity');

    for (let i = 0; i < 10; i++) {
      (s as any).runStatusTick();
    }

    const afterClear = spy.mock.calls[spy.mock.calls.length - 1] as [any];
    expect(Math.abs(afterClear[0].ambientGain - 0.5)).toBeLessThan(0.02);
  });

  test('setActivity with pose only does not disturb bus state', () => {
    const compiler = (s as any).compiler;
    const stateMachine = (s as any).stateMachine;
    (s as any).previewServer = { updateStatus: () => {} };

    // Set up a known bus state
    s.setActivity({ ambientGain: 0.5 });
    const snapBefore = (s as any).ambientBus.snapshot();
    expect(snapBefore.sources.activity).toBe(0.5);

    // Now send a pose-only patch
    const spy = spyOn(compiler, 'setActivity');
    s.setActivity({ pose: 'thinking' });

    // setActivity should have been called (pose changed), but bus state unchanged
    const snapAfter = (s as any).ambientBus.snapshot();
    expect(snapAfter.sources.activity).toBe(0.5);
  });
});
