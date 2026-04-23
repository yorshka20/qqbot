import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { AvatarService } from '../AvatarService';
import type { IdleClip } from '../compiler/layers/clips/types';

type WalkingLayerStub = {
  id: 'walking';
  walkTo: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  getPosition: ReturnType<typeof mock>;
  walkPromise: Promise<void>;
};

function makeWalkingLayer() {
  const walkPromise = Promise.resolve();
  return {
    id: 'walking' as const,
    walkTo: mock(() => walkPromise),
    stop: mock(() => {}),
    getPosition: mock(() => ({ x: 1.25, z: -0.5, facing: Math.PI / 4 })),
    walkPromise,
  };
}

describe('AvatarService walking facade', () => {
  let service: AvatarService;

  beforeEach(() => {
    service = new AvatarService();
  });

  test('walkTo() delegates to WalkingLayer and returns its promise', async () => {
    const layer = makeWalkingLayer();
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [layer];

    const result = service.walkTo(3, 4, Math.PI);

    expect(result).toBe(layer.walkPromise);
    expect(layer.walkTo).toHaveBeenCalledWith(3, 4, Math.PI);
    await result;
  });

  test('stopWalk() delegates to WalkingLayer.stop()', () => {
    const layer = makeWalkingLayer();
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [layer];

    service.stopWalk();

    expect(layer.stop).toHaveBeenCalledTimes(1);
  });

  test('getCurrentPosition() returns the walking layer position', () => {
    const layer = makeWalkingLayer();
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [layer];

    expect(service.getCurrentPosition()).toEqual({ x: 1.25, z: -0.5, facing: Math.PI / 4 });
  });

  test('missing walking layer falls back cleanly', async () => {
    const testService = service as unknown as { defaultLayers: WalkingLayerStub[] };
    testService.defaultLayers = [];

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

    const svc = service as any;
    const walkingLayer = svc.defaultLayers.find((l: any) => l.id === 'walking');
    expect(walkingLayer).toBeDefined();
    const setCycleSpy = spyOn(walkingLayer, 'setWalkCycleClip');

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

    const svc = service as any;
    const mockClip: IdleClip = { id: 'test_walk_clip', duration: 1.2, tracks: [] };

    // Return the mock clip only for the walk cycle action name; delegate others to real implementation.
    const compiler = svc.compiler;
    const realGetClip = compiler.getClipByActionName.bind(compiler);
    spyOn(compiler, 'getClipByActionName').mockImplementation((name: string) =>
      name === 'test_walk_clip' ? mockClip : realGetClip(name),
    );

    const walkingLayer = svc.defaultLayers.find((l: any) => l.id === 'walking');
    expect(walkingLayer).toBeDefined();
    const setCycleSpy = spyOn(walkingLayer, 'setWalkCycleClip');

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

    const svc = service as any;
    const realGetClip = svc.compiler.getClipByActionName.bind(svc.compiler);
    spyOn(svc.compiler, 'getClipByActionName').mockImplementation((name: string) =>
      name === 'missing_clip' ? null : realGetClip(name),
    );

    const walkingLayer = svc.defaultLayers.find((l: any) => l.id === 'walking');
    expect(walkingLayer).toBeDefined();
    const setCycleSpy = spyOn(walkingLayer, 'setWalkCycleClip');

    await expect(service.start()).resolves.toBeUndefined();
    expect(setCycleSpy).not.toHaveBeenCalled();
  });
});
