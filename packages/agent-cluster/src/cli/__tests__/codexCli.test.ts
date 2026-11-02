import { describe, expect, test } from 'bun:test';
import { codexMcpServerArgs, withoutCodexApiKeys } from '../codexCli';

describe('withoutCodexApiKeys', () => {
  test('removes both variables that would replace the ChatGPT login', () => {
    const env = withoutCodexApiKeys({ CODEX_API_KEY: 'a', OPENAI_API_KEY: 'b', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  test('does not mutate the input', () => {
    const input = { OPENAI_API_KEY: 'b' };
    withoutCodexApiKeys(input);
    expect(input).toEqual({ OPENAI_API_KEY: 'b' });
  });
});

describe('codexMcpServerArgs', () => {
  test('emits TOML values codex parses as a url string and a header table', () => {
    expect(codexMcpServerArgs('qqbot', 'http://127.0.0.1:9876/mcp', { 'X-Task-Id': 'task-1' })).toEqual([
      '-c',
      'mcp_servers.qqbot.url="http://127.0.0.1:9876/mcp"',
      '-c',
      'mcp_servers.qqbot.http_headers={"X-Task-Id"="task-1"}',
    ]);
  });
});
