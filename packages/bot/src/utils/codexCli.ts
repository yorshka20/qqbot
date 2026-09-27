/**
 * Invocation rules shared by everything that spawns the OpenAI Codex CLI.
 *
 * Codex runs from the ChatGPT login stored in `<CODEX_HOME>/auth.json`, never
 * from an API key. `codex exec` lets `CODEX_API_KEY` override that login, and
 * an `apikey`-mode login would read `OPENAI_API_KEY`, so both are removed from
 * every environment a codex process is started with.
 */

const CODEX_API_KEY_ENV_VARS = ['CODEX_API_KEY', 'OPENAI_API_KEY'];

export function withoutCodexApiKeys(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const scrubbed = { ...env };
  for (const name of CODEX_API_KEY_ENV_VARS) {
    delete scrubbed[name];
  }
  return scrubbed;
}

/**
 * `-c` overrides that register one Streamable-HTTP MCP server for a single
 * codex process. Scoped to the process, unlike an entry in `config.toml`, so
 * concurrent codex runs can each carry their own headers.
 */
export function codexMcpServerArgs(name: string, url: string, headers: Record<string, string>): string[] {
  const headerTable = Object.entries(headers)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(', ');
  return [
    '-c',
    `mcp_servers.${name}.url=${JSON.stringify(url)}`,
    '-c',
    `mcp_servers.${name}.http_headers={${headerTable}}`,
  ];
}
