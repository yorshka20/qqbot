import { describe, expect, test } from 'bun:test';
import { MCP_TOOL_CALL_TIMEOUT_MS } from '../../hub/waitWindow';
import type { WorkerSpawnConfig } from '../../types';
import { ClaudeCliBackend } from '../ClaudeCliBackend';

const spawnConfig = (env: Record<string, string>): WorkerSpawnConfig =>
  ({
    workerId: 'w-1',
    command: 'claude',
    args: ['--print', '--output-format', 'stream-json'],
    env,
    projectPath: '/tmp/project',
    mcpConfigPath: '/tmp/mcp.json',
    taskPrompt: 'do the thing',
  }) as unknown as WorkerSpawnConfig;

describe('ClaudeCliBackend.launch', () => {
  test('raises the CLI per-call MCP limit past the hub wait window', async () => {
    const launch = await new ClaudeCliBackend().launch(spawnConfig({ PATH: '/usr/bin' }));
    expect(launch.env.MCP_TOOL_TIMEOUT).toBe(String(MCP_TOOL_CALL_TIMEOUT_MS));
    expect(launch.env.PATH).toBe('/usr/bin');
  });

  test('keeps a template-provided MCP_TOOL_TIMEOUT', async () => {
    const launch = await new ClaudeCliBackend().launch(spawnConfig({ MCP_TOOL_TIMEOUT: '999' }));
    expect(launch.env.MCP_TOOL_TIMEOUT).toBe('999');
  });
});
