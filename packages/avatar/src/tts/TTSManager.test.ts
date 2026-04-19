import 'reflect-metadata';

import { beforeEach, describe, expect, it } from 'bun:test';
import { TTSManager } from './TTSManager';
import type { SynthesisResult, TTSProvider, TTSSynthesizeOptions } from './TTSProvider';

function makeProvider(name: string, available = true): TTSProvider {
  return {
    name,
    isAvailable: () => available,
    synthesize: async (_text: string, _opts?: TTSSynthesizeOptions): Promise<SynthesisResult> => ({
      bytes: new Uint8Array(0),
      mime: 'audio/mpeg',
      durationMs: 0,
    }),
  };
}

describe('TTSManager', () => {
  let manager: TTSManager;

  beforeEach(() => {
    manager = new TTSManager();
  });

  it('starts empty', () => {
    expect(manager.list()).toEqual([]);
    expect(manager.listAll()).toEqual([]);
    expect(manager.getDefault()).toBeNull();
  });

  it('register makes the provider available', () => {
    const p = makeProvider('fish-audio');
    manager.register(p);
    expect(manager.get('fish-audio')).toBe(p);
    expect(manager.list()).toHaveLength(1);
  });

  it('first registered provider becomes default', () => {
    const p = makeProvider('fish-audio');
    manager.register(p);
    expect(manager.getDefault()).toBe(p);
  });

  it('second registered provider does not replace default', () => {
    const first = makeProvider('fish-audio');
    const second = makeProvider('sovits');
    manager.register(first);
    manager.register(second);
    expect(manager.getDefault()).toBe(first);
  });

  it('setDefault changes the default provider', () => {
    const first = makeProvider('fish-audio');
    const second = makeProvider('sovits');
    manager.register(first);
    manager.register(second);
    manager.setDefault('sovits');
    expect(manager.getDefault()).toBe(second);
  });

  it('setDefault throws when name is not registered', () => {
    expect(() => manager.setDefault('nonexistent')).toThrow();
  });

  it('get returns null for unknown name', () => {
    expect(manager.get('unknown')).toBeNull();
  });

  it('unregister removes a provider and returns true', () => {
    manager.register(makeProvider('fish-audio'));
    const removed = manager.unregister('fish-audio');
    expect(removed).toBe(true);
    expect(manager.get('fish-audio')).toBeNull();
  });

  it('unregister returns false for unknown name', () => {
    expect(manager.unregister('unknown')).toBe(false);
  });

  it('unregistering the default provider picks a new default', () => {
    const first = makeProvider('fish-audio');
    const second = makeProvider('sovits');
    manager.register(first);
    manager.register(second);
    manager.unregister('fish-audio');
    expect(manager.getDefault()).toBe(second);
  });

  it('unregistering the last provider sets default to null', () => {
    manager.register(makeProvider('fish-audio'));
    manager.unregister('fish-audio');
    expect(manager.getDefault()).toBeNull();
  });

  it('list() excludes unavailable providers', () => {
    manager.register(makeProvider('fish-audio', true));
    manager.register(makeProvider('sovits', false));
    const available = manager.list();
    expect(available).toHaveLength(1);
    expect(available[0].name).toBe('fish-audio');
  });

  it('listAll() includes unavailable providers', () => {
    manager.register(makeProvider('fish-audio', true));
    manager.register(makeProvider('sovits', false));
    expect(manager.listAll()).toHaveLength(2);
  });

  it('getDefault returns null when default provider is unavailable', () => {
    manager.register(makeProvider('fish-audio', false));
    expect(manager.getDefault()).toBeNull();
  });

  it('re-registering a provider with the same name overwrites it', () => {
    const first = makeProvider('fish-audio');
    const second = makeProvider('fish-audio');
    manager.register(first);
    manager.register(second);
    expect(manager.get('fish-audio')).toBe(second);
    expect(manager.listAll()).toHaveLength(1);
  });
});
