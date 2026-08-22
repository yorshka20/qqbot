// Tests that the subagent scope honours adminOnly.
//
// Regression guard: the subagent branch of getToolsByScope only checked
// `visibility.subagent === true`, so `adminOnly` was never applied there. The
// reply scope filters it via filterToolsForReply, but a subagent bypasses that
// path entirely — which handed any non-admin user read_file / search_code /
// execute_code through a spawned subagent.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { ToolManager } from '../ToolManager';
import type { ToolSpec } from '../types';

const ADMIN_TOOL: ToolSpec = {
  name: 'read_file',
  description: 'reads files',
  executor: 'read_file',
  visibility: { reply: { sources: ['qq-private'], adminOnly: true }, subagent: true },
};

const OPEN_TOOL: ToolSpec = {
  name: 'search',
  description: 'web search',
  executor: 'search',
  visibility: { reply: { sources: ['qq-private'], adminOnly: false }, subagent: true },
};

const BARE_REPLY_TOOL: ToolSpec = {
  name: 'list_bot_features',
  description: 'lists features',
  executor: 'list_bot_features',
  visibility: { reply: true, subagent: true },
};

function managerWith(specs: ToolSpec[]): ToolManager {
  const manager = new ToolManager();
  for (const spec of specs) {
    manager.registerTool(spec);
  }
  return manager;
}

describe('getToolsByScope subagent adminOnly gate', () => {
  const specs = [ADMIN_TOOL, OPEN_TOOL, BARE_REPLY_TOOL];

  it('hides adminOnly tools from a non-admin subagent', () => {
    const names = managerWith(specs)
      .getToolsByScope('subagent', { isAdmin: false })
      .map((t) => t.name);
    expect(names).not.toContain('read_file');
    expect(names).toContain('search');
  });

  it('exposes adminOnly tools to an admin subagent', () => {
    const names = managerWith(specs)
      .getToolsByScope('subagent', { isAdmin: true })
      .map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('search');
  });

  it('defaults to the non-admin set when the caller cannot determine admin status', () => {
    const names = managerWith(specs)
      .getToolsByScope('subagent')
      .map((t) => t.name);
    expect(names).not.toContain('read_file');
  });

  it('treats a bare `reply: true` visibility as not adminOnly', () => {
    const names = managerWith(specs)
      .getToolsByScope('subagent', { isAdmin: false })
      .map((t) => t.name);
    expect(names).toContain('list_bot_features');
  });

  it('leaves the reply scope untouched — it has its own filter', () => {
    const names = managerWith(specs)
      .getToolsByScope('reply')
      .map((t) => t.name);
    expect(names).toContain('read_file');
  });
});
