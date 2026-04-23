import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { AnimationCompiler } from '../compiler/AnimationCompiler';
import type { IdleClip } from '../compiler/layers/clips/types';
import type { WalkingLayer } from '../compiler/layers/WalkingLayer';

function testCompiler(service: AvatarService): AnimationCompiler {
  const c = (service as unknown as { compiler: AnimationCompiler | null }).compiler;
  if (!c) throw new Error('expected compiler after initialize()');
  return c;
}

describe('AvatarService walking facade', () => {
  let service: AvatarService;

  beforeEach(async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 30, outputFps: 30 },
    });
  });

  function walkingOf(s: AvatarService): WalkingLayer {
    return testCompiler(s).getLayer('walking') as WalkingLayer;
  }

  test('walkTo() delegates to WalkingLayer and returns its promise', async () => {
    const walkingLayer = walkingOf(service);
    const walkPromise = Promise.resolve();
    const spy = spyOn(walkingLayer, 'walkTo').mockReturnValue(walkPromise);

    const result = service.walkTo(3, 4, Math.PI);

    expect(result).toBe(walkPromise);
    expect(spy).toHaveBeenCalledWith(3, 4, Math.PI);
    await result;
  });

  test('stopWalk() delegates to WalkingLayer.stop()', () => {
    const walkingLayer = walkingOf(service);
    const spy = spyOn(walkingLayer, 'stop');

    service.stopWalk();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('getCurrentPosition() returns the walking layer position', () => {
    const walkingLayer = walkingOf(service);
    spyOn(walkingLayer, 'getPosition').mockReturnValue({ x: 1.25, z: -0.5, facing: Math.PI / 4 });

    expect(service.getCurrentPosition()).toEqual({ x: 1.25, z: -0.5, facing: Math.PI / 4 });
  });

  test('missing walking layer falls back cleanly', async () => {
    testCompiler(service).unregisterLayer('walking');

    await expect(service.walkTo(1, 2, 3)).rejects.toThrow('[AvatarService] WalkingLayer is not available');
    expect(() => service.stopWalk()).not.toThrow();
    expect(service.getCurrentPosition()).toEqual({ x: 0, z: 0, facing: 0 });
  });

  test('stop() remains the async lifecycle API', async () => {
    const result = service.stop();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});

describe('AvatarService walk-cycle clip wiring', () => {
  let service: AvatarService;

  afterEach(async () => {
    await service.stop();
  });

  test('cycleClipActionName absent — setWalkCycleClip not called during start()', async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 30, outputFps: 30 },
    });

    const walkingLayer = testCompiler(service).getLayer('walking');
    expect(walkingLayer).toBeDefined();
    const setCycleSpy = spyOn(walkingLayer as WalkingLayer, 'setWalkCycleClip');

    await service.start();

    expect(setCycleSpy).not.toHaveBeenCalled();
  });

  test('cycleClipActionName configured + clip resolves — setWalkCycleClip called once with clip', async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 30, outputFps: 30, walk: { cycleClipActionName: 'test_walk_clip' } },
    });

    const compiler = testCompiler(service);
    const mockClip: IdleClip = { id: 'test_walk_clip', duration: 1.2, tracks: [] };

    // Return the mock clip only for the walk cycle action name; delegate others to real implementation.
    const realGetClip = compiler.getClipByActionName.bind(compiler);
    spyOn(compiler, 'getClipByActionName').mockImplementation((name: string) =>
      name === 'test_walk_clip' ? mockClip : realGetClip(name),
    );

    const walkingLayer = compiler.getLayer('walking');
    expect(walkingLayer).toBeDefined();
    const setCycleSpy = spyOn(walkingLayer as WalkingLayer, 'setWalkCycleClip');

    await service.start();

    expect(setCycleSpy).toHaveBeenCalledTimes(1);
    expect(setCycleSpy).toHaveBeenCalledWith(mockClip);
  });

  test('cycleClipActionName configured but unresolved — no throw, setWalkCycleClip not called', async () => {
    service = new AvatarService();
    await service.initialize({
      enabled: true,
      vts: { enabled: false },
      preview: { enabled: false },
      speech: { enabled: false },
      compiler: { fps: 30, outputFps: 30, walk: { cycleClipActionName: 'missing_clip' } },
    });

    const compiler = testCompiler(service);
    const realGetClip = compiler.getClipByActionName.bind(compiler);
    spyOn(compiler, 'getClipByActionName').mockImplementation((name: string) =>
      name === 'missing_clip' ? null : realGetClip(name),
    );

    const walkingLayer = compiler.getLayer('walking');
    expect(walkingLayer).toBeDefined();
    const setCycleSpy = spyOn(walkingLayer as WalkingLayer, 'setWalkCycleClip');

    await expect(service.start()).resolves.toBeUndefined();
    expect(setCycleSpy).not.toHaveBeenCalled();
  });
});
