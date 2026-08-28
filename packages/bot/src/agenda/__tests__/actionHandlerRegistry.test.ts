import { describe, expect, it } from 'bun:test';
import { type ActionHandler, ActionHandlerRegistry } from '../ActionHandlerRegistry';

function makeHandler(name: string): ActionHandler {
  return {
    name,
    execute: async () => undefined,
  };
}

describe('ActionHandlerRegistry', () => {
  it('registers and resolves handlers by name', () => {
    const registry = new ActionHandlerRegistry();
    const handler = makeHandler('group_report');

    registry.register(handler);

    expect(registry.get('group_report')).toBe(handler);
    expect(registry.getNames()).toEqual(['group_report']);
  });

  it('unregisters a handler so a disabled plugin leaves nothing behind', () => {
    const registry = new ActionHandlerRegistry();
    registry.register(makeHandler('group_report'));

    registry.unregister('group_report');

    expect(registry.get('group_report')).toBeUndefined();
    expect(registry.getNames()).toEqual([]);
  });

  it('tolerates unregistering a name that was never registered', () => {
    const registry = new ActionHandlerRegistry();
    expect(() => registry.unregister('nope')).not.toThrow();
  });

  it('re-registers after unregister (plugin disabled then enabled again)', () => {
    const registry = new ActionHandlerRegistry();
    registry.register(makeHandler('group_report'));
    registry.unregister('group_report');

    const second = makeHandler('group_report');
    registry.register(second);

    expect(registry.get('group_report')).toBe(second);
  });
});
