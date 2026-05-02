import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'bun:test';
import { PromptInjectionRegistry } from '../PromptInjectionRegistry';
import type { PromptInjectionContext, PromptInjectionProducer } from '../types';

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

function makeCtx(source: string): PromptInjectionContext {
  return { source: source as PromptInjectionContext['source'], hookContext: { source } as any };
}

describe('PromptInjectionRegistry.gatherByLayer', () => {
  let registry: PromptInjectionRegistry;
  beforeEach(() => {
    registry = new PromptInjectionRegistry();
  });

  it('groups producers by their declared layer', async () => {
    const baseline: PromptInjectionProducer = {
      name: 'b',
      layer: 'baseline',
      produce: () => ({ producerName: 'b', fragment: 'B' }),
    };
    const scene: PromptInjectionProducer = {
      name: 's',
      layer: 'scene',
      produce: () => ({ producerName: 's', fragment: 'S' }),
    };
    const runtime: PromptInjectionProducer = {
      name: 'r',
      layer: 'runtime',
      produce: () => ({ producerName: 'r', fragment: 'R' }),
    };
    const tool: PromptInjectionProducer = {
      name: 't',
      layer: 'tool',
      produce: () => ({ producerName: 't', fragment: 'T' }),
    };
    [baseline, scene, runtime, tool].forEach((p) => registry.register(p));
    const out = await registry.gatherByLayer(makeCtx('qq-private'));
    expect(out.baseline.map((i) => i.fragment)).toEqual(['B']);
    expect(out.scene.map((i) => i.fragment)).toEqual(['S']);
    expect(out.runtime.map((i) => i.fragment)).toEqual(['R']);
    expect(out.tool.map((i) => i.fragment)).toEqual(['T']);
  });

  it('returns [] (not undefined) for empty layers', async () => {
    const out = await registry.gatherByLayer(makeCtx('qq-private'));
    expect(out.baseline).toEqual([]);
    expect(out.scene).toEqual([]);
    expect(out.runtime).toEqual([]);
    expect(out.tool).toEqual([]);
  });

  it('sorts within a layer by ascending priority (default 100)', async () => {
    const a: PromptInjectionProducer = {
      name: 'a',
      layer: 'runtime',
      priority: 100,
      produce: () => ({ producerName: 'a', priority: 100, fragment: 'a' }),
    };
    const b: PromptInjectionProducer = {
      name: 'b',
      layer: 'runtime',
      priority: 10,
      produce: () => ({ producerName: 'b', priority: 10, fragment: 'b' }),
    };
    const c: PromptInjectionProducer = {
      name: 'c',
      layer: 'runtime',
      produce: () => ({ producerName: 'c', fragment: 'c' }),
    }; // default 100
    [a, b, c].forEach((p) => registry.register(p));
    const out = await registry.gatherByLayer(makeCtx('qq-private'));
    expect(out.runtime.map((i) => i.fragment)).toEqual(['b', 'a', 'c']);
  });

  it('applicableSources filters before grouping', async () => {
    const fn = vi.fn(() => ({ producerName: 'p', fragment: 'p' }));
    const p: PromptInjectionProducer = { name: 'p', layer: 'baseline', applicableSources: ['qq-private'], produce: fn };
    registry.register(p);
    const out = await registry.gatherByLayer(makeCtx('idle-trigger'));
    expect(fn).not.toHaveBeenCalled();
    expect(out.baseline).toEqual([]);
  });

  it('throwing producer does not break other layers', async () => {
    const { logger } = await import('@/utils/logger');
    const thrower: PromptInjectionProducer = {
      name: 'thrower',
      layer: 'baseline',
      produce: () => {
        throw new Error('boom');
      },
    };
    const good: PromptInjectionProducer = {
      name: 'good',
      layer: 'scene',
      produce: () => ({ producerName: 'good', fragment: 'G' }),
    };
    registry.register(thrower);
    registry.register(good);
    const out = await registry.gatherByLayer(makeCtx('qq-private'));
    expect(out.baseline).toEqual([]);
    expect(out.scene.map((i) => i.fragment)).toEqual(['G']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"thrower" threw'));
  });
});
