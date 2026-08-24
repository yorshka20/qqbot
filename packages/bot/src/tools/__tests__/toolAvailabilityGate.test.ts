// Tests the `available` gate: a tool backed by a service must leave the catalog
// while that service is down and come back on its own when it recovers,
// without any register/unregister round trip.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { ToolManager } from '../ToolManager';
import type { ToolSpec } from '../types';

function managerWith(specs: ToolSpec[]): ToolManager {
  const manager = new ToolManager();
  for (const spec of specs) {
    manager.registerTool(spec);
  }
  return manager;
}

describe('tool availability gate', () => {
  it('follows the predicate in both directions', () => {
    let healthy = true;
    const manager = managerWith([
      {
        name: 'speak',
        description: 'voice reply',
        executor: 'speak',
        visibility: { reply: { sources: ['qq-private'] }, subagent: true },
        available: () => healthy,
      },
    ]);

    expect(manager.getToolsByScope('reply').map((t) => t.name)).toEqual(['speak']);

    healthy = false;
    expect(manager.getToolsByScope('reply')).toEqual([]);
    expect(manager.getToolsByScope('subagent', { isAdmin: true })).toEqual([]);

    healthy = true;
    expect(manager.getToolsByScope('reply').map((t) => t.name)).toEqual(['speak']);
  });

  it('hides a tool whose predicate throws, keeping the rest of the catalog', () => {
    const manager = managerWith([
      {
        name: 'broken',
        description: 'throws on check',
        executor: 'broken',
        visibility: { reply: true },
        available: () => {
          throw new Error('health backend exploded');
        },
      },
      { name: 'search', description: 'web search', executor: 'search', visibility: { reply: true } },
    ]);

    expect(manager.getToolsByScope('reply').map((t) => t.name)).toEqual(['search']);
  });

  it('treats a tool without a predicate as always available', () => {
    const manager = managerWith([
      { name: 'search', description: 'web search', executor: 'search', visibility: { reply: true } },
    ]);
    expect(manager.getToolsByScope('reply').map((t) => t.name)).toEqual(['search']);
  });
});
