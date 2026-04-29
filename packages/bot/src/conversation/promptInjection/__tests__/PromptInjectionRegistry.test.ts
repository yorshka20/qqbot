import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { PromptInjectionRegistry } from '../PromptInjectionRegistry';
import type { PromptInjectionContext, PromptInjectionProducer } from '../types';

// Stub a minimal HookContext — gather only uses ctx.source
function makeCtx(source: string): PromptInjectionContext {
  return {
    source: source as PromptInjectionContext['source'],
    hookContext: { source } as any,
  };
}

// Stub logger so we can spy on warn without real logger setup
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PromptInjectionRegistry', () => {
  let registry: PromptInjectionRegistry;

  beforeEach(() => {
    registry = new PromptInjectionRegistry();
  });

  it('case 1: register then gather returns the producer fragment', async () => {
    const producer: PromptInjectionProducer = {
      name: 'test-producer',
      produce: () => ({ producerName: 'test-producer', fragment: 'hello world' }),
    };
    registry.register(producer);
    const results = await registry.gather(makeCtx('qq-private'));
    expect(results).toHaveLength(1);
    expect(results[0].fragment).toBe('hello world');
    expect(results[0].producerName).toBe('test-producer');
  });

  it('case 2: unregister callback removes the producer', async () => {
    const producer: PromptInjectionProducer = {
      name: 'removable',
      produce: () => ({ producerName: 'removable', fragment: 'some text' }),
    };
    const unregister = registry.register(producer);
    unregister();
    const results = await registry.gather(makeCtx('qq-private'));
    expect(results).toHaveLength(0);
  });

  it('case 3: applicableSources filter — produce NOT called for non-matching source', async () => {
    const produceFn = vi.fn(() => ({ producerName: 'filtered', fragment: 'filtered text' }));
    const producer: PromptInjectionProducer = {
      name: 'filtered',
      applicableSources: ['qq-private'],
      produce: produceFn,
    };
    registry.register(producer);
    const results = await registry.gather(makeCtx('idle-trigger'));
    expect(produceFn).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it('case 4: throwing producer does not prevent good producer from contributing', async () => {
    const { logger } = await import('@/utils/logger');
    const thrower: PromptInjectionProducer = {
      name: 'thrower',
      produce: () => { throw new Error('boom'); },
    };
    const good: PromptInjectionProducer = {
      name: 'good',
      produce: () => ({ producerName: 'good', fragment: 'good fragment' }),
    };
    registry.register(thrower);
    registry.register(good);
    const results = await registry.gather(makeCtx('qq-private'));
    expect(results).toHaveLength(1);
    expect(results[0].fragment).toBe('good fragment');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"thrower" threw'));
  });

  it('case 5: empty-string fragment and null result are filtered out', async () => {
    const emptyProducer: PromptInjectionProducer = {
      name: 'empty',
      produce: () => ({ producerName: 'empty', fragment: '' }),
    };
    const nullProducer: PromptInjectionProducer = {
      name: 'null-producer',
      produce: () => null,
    };
    registry.register(emptyProducer);
    registry.register(nullProducer);
    const results = await registry.gather(makeCtx('qq-private'));
    expect(results).toHaveLength(0);
  });

  it('case 6: priority ordering — output sorted ascending, undefined priority defaults to 100', async () => {
    const p100: PromptInjectionProducer = {
      name: 'p100',
      priority: 100,
      produce: () => ({ producerName: 'p100', priority: 100, fragment: 'fragment-100' }),
    };
    const p10: PromptInjectionProducer = {
      name: 'p10',
      priority: 10,
      produce: () => ({ producerName: 'p10', priority: 10, fragment: 'fragment-10' }),
    };
    const p50: PromptInjectionProducer = {
      name: 'p50',
      priority: 50,
      produce: () => ({ producerName: 'p50', priority: 50, fragment: 'fragment-50' }),
    };
    const pUndefined: PromptInjectionProducer = {
      name: 'pUndefined',
      // no priority — should default to 100
      produce: () => ({ producerName: 'pUndefined', fragment: 'fragment-undefined' }),
    };
    registry.register(p100);
    registry.register(p10);
    registry.register(p50);
    registry.register(pUndefined);
    const results = await registry.gather(makeCtx('qq-private'));
    expect(results).toHaveLength(4);
    expect(results[0].producerName).toBe('p10');
    expect(results[1].producerName).toBe('p50');
    // p100 and pUndefined both have effective priority 100 — order between them is stable (insertion order)
    expect(results[2].producerName).toBe('p100');
    expect(results[3].producerName).toBe('pUndefined');
  });

  it('case 7 (bonus): producer with no applicableSources applies to any source', async () => {
    const producer: PromptInjectionProducer = {
      name: 'universal',
      produce: () => ({ producerName: 'universal', fragment: 'universal fragment' }),
    };
    registry.register(producer);
    const results = await registry.gather(makeCtx('idle-trigger'));
    expect(results).toHaveLength(1);
    expect(results[0].fragment).toBe('universal fragment');
  });
});
