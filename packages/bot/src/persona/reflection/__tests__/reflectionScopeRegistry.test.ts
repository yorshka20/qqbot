// Verifies that all 4 reflection-scope tools are registered and visible.
// Importing '@/tools/executors' triggers all decorator side-effects.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import '@/tools/executors'; // triggers all @Tool decorator side-effects (includes new executors via re-exports)
import { ToolManager } from '@/tools/ToolManager';

describe('reflection scope registry', () => {
  it('exposes exactly the 4 expected tools under reflection scope', () => {
    const tm = new ToolManager();
    tm.autoRegisterTools();
    const names = tm.getToolsByScope('reflection').map((t) => t.name);
    expect(names).toContain('get_memory');
    expect(names).toContain('search_chat_history');
    expect(names).toContain('epigenetics_history');
    expect(names).toContain('relationship_history');
  });
});
