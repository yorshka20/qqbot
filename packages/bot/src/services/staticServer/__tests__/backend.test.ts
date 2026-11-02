import { describe, expect, it } from 'bun:test';
import {
  assertDisjointPrefixes,
  type Backend,
  createRegisteredBackends,
  registeredBackendIds,
  registerStaticBackend,
} from '../backend';

function fake(prefix: string): Backend {
  return { prefix, handle: () => null };
}

describe('assertDisjointPrefixes', () => {
  it('accepts prefixes that cannot shadow each other', () => {
    expect(() => assertDisjointPrefixes([fake('/api/docs'), fake('/api/doc'), fake('/output')])).not.toThrow();
  });

  it('rejects two backends on the same prefix', () => {
    expect(() => assertDisjointPrefixes([fake('/api/memory'), fake('/api/memory')])).toThrow(/shadows/);
  });

  it('rejects a prefix that swallows another backend’s routes', () => {
    expect(() => assertDisjointPrefixes([fake('/api'), fake('/api/cluster')])).toThrow(/shadows/);
  });
});

describe('registerStaticBackend', () => {
  it('keeps the first registration of an id, so a module reload adds no route', () => {
    registerStaticBackend({ id: 'test-dedupe', create: () => fake('/test-dedupe/first') });
    registerStaticBackend({ id: 'test-dedupe', create: () => fake('/test-dedupe/second') });

    const built = createRegisteredBackends({ baseDir: '/tmp' }, { disabledIds: disablingAllBut('test-dedupe') });

    expect(built.map((b) => b.prefix)).toEqual(['/test-dedupe/first']);
  });

  it('omits a disabled id', () => {
    registerStaticBackend({ id: 'test-disabled', create: () => fake('/test-disabled') });

    const built = createRegisteredBackends({ baseDir: '/tmp' }, { disabledIds: disablingAllBut() });

    expect(built).toEqual([]);
  });
});

/**
 * The registry is module-level state shared with every backend module this test file
 * happens to pull in, so a case that wants to look at one entry disables the rest.
 */
function disablingAllBut(...keep: string[]): ReadonlySet<string> {
  return new Set(registeredBackendIds().filter((id) => !keep.includes(id)));
}
