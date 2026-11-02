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

interface CodexCatalogModel {
  slug: string;
  visibility?: string;
  supported_reasoning_levels?: Array<{ effort: string }>;
}

/**
 * The models this codex install offers, from `codex debug models` (a local
 * catalog read, no model call). Hidden entries are internal and left out.
 */
export async function listCodexModels(cliPath: string): Promise<Array<{ id: string; efforts: string[] }>> {
  const proc = Bun.spawn({
    cmd: [cliPath, 'debug', 'models'],
    env: withoutCodexApiKeys(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`codex debug models failed (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`);
  }
  const catalog = JSON.parse(stdout) as { models: CodexCatalogModel[] };
  return catalog.models
    .filter((m) => m.visibility === 'list')
    .map((m) => ({ id: m.slug, efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort) }));
}
