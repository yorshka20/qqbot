import 'reflect-metadata';

import { describe, expect, it } from 'bun:test';
import { getToolMetadata, metadataToToolSpec, Tool } from '../decorators';
import { BaseToolExecutor } from '../executors/BaseToolExecutor';
import type { ToolCall, ToolExecutionContext, ToolResult } from '../types';
import { normalizeVisibility } from '../types';

describe('normalizeVisibility', () => {
  it('converts ToolScope[] to ToolVisibility', () => {
    expect(normalizeVisibility(['reply', 'subagent'])).toEqual({ reply: true, subagent: true });
  });

  it('handles internal-only', () => {
    expect(normalizeVisibility(['internal'])).toEqual({ internal: true });
  });

  it('handles reflection scope', () => {
    expect(normalizeVisibility(['reflection'])).toEqual({ reflection: true });
  });

  it('returns empty object for undefined', () => {
    expect(normalizeVisibility(undefined)).toEqual({});
  });

  it('passes ToolVisibility through unchanged', () => {
    const v = { reply: { sources: ['qq-group' as const], adminOnly: true }, subagent: true };
    expect(normalizeVisibility(v)).toEqual(v);
  });

  it('handles all scopes at once', () => {
    expect(normalizeVisibility(['reply', 'subagent', 'internal', 'reflection'])).toEqual({
      reply: true,
      subagent: true,
      internal: true,
      reflection: true,
    });
  });

  it('returns empty object for empty array', () => {
    expect(normalizeVisibility([])).toEqual({});
  });
});

describe('@Tool decorator normalize integration', () => {
  it('legacy ToolScope[] form produces ToolSpec.visibility = { reply: true }', () => {
    @Tool({
      name: 'test_legacy_normalize',
      description: 'x',
      executor: 'noop',
      visibility: ['reply'],
    })
    class TestLegacyTool extends BaseToolExecutor {
      name = 'noop';
      execute(_call: ToolCall, _context: ToolExecutionContext): ToolResult {
        return { success: true, reply: '' };
      }
    }

    const meta = getToolMetadata(TestLegacyTool)!;
    const spec = metadataToToolSpec(meta);
    expect(spec.visibility).toEqual({ reply: true });
  });

  it('ToolVisibility object form passes through unchanged', () => {
    @Tool({
      name: 'test_toolvisibility_normalize',
      description: 'y',
      executor: 'noop2',
      visibility: { reply: { sources: ['qq-private'], adminOnly: false }, subagent: true },
    })
    class TestVisibilityTool extends BaseToolExecutor {
      name = 'noop2';
      execute(_call: ToolCall, _context: ToolExecutionContext): ToolResult {
        return { success: true, reply: '' };
      }
    }

    const meta = getToolMetadata(TestVisibilityTool)!;
    const spec = metadataToToolSpec(meta);
    expect(spec.visibility).toEqual({
      reply: { sources: ['qq-private'], adminOnly: false },
      subagent: true,
    });
  });
});
