/**
 * Provider credential checks shared by worker backends.
 *
 * A worker template is only useful if its CLI can authenticate against the
 * provider it targets. Confirming that by spawning the CLI costs a full agent
 * turn — the harness ships its system prompt and tool schema on every
 * invocation regardless of how trivial the prompt is — so these helpers ask
 * the provider directly instead: a single GET against a model-metadata
 * endpoint, which every provider used here serves without billing tokens.
 *
 * Which endpoint each provider answers on is load-bearing and differs between
 * providers that otherwise share a wire format; see each exported helper.
 */

import { readFile } from 'node:fs/promises';
import type { CredentialProbeResult } from '../types';

const ANTHROPIC_VERSION = '2023-06-01';

/** Pulls `error.message` out of the JSON error body these providers return. */
function describeFailure(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.length > 0) {
      return `HTTP ${status}: ${message}`;
    }
  } catch {
    // Non-JSON body (proxy error page, gateway timeout) — fall through to the snippet.
  }
  const snippet = body.trim().slice(0, 160);
  return snippet.length > 0 ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

async function getModelMetadata(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    if (!response.ok) return { ok: false, reason: describeFailure(response.status, body) };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, reason: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * OpenAI's Responses API — the endpoint `codex` actually drives.
 *
 * Passing the model listing does not imply access here: OpenAI project keys
 * can be scoped per endpoint, so a key may read model metadata and still be
 * refused for inference. Authorization therefore has to be probed where it
 * will be used. Sending a body that is deliberately missing `input` keeps that
 * free — the request is rejected during parameter validation, before any
 * inference is billed — so only an outright auth rejection (401/403) or a
 * provider-side failure means the credential is unusable. Any other 4xx is
 * the validation error we asked for, which proves authorization succeeded.
 */
export async function checkOpenAiResponsesAccess(input: {
  baseUrl: string;
  model?: string;
  apiKey: string;
  credentialSource: string;
  timeoutMs: number;
}): Promise<CredentialProbeResult> {
  const endpoint = `${input.baseUrl.replace(/\/$/, '')}/responses`;
  const fields = { credentialSource: input.credentialSource, endpoint, model: input.model };
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(input.model ? { model: input.model } : {}),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      return { ok: false, ...fields, reason: describeFailure(response.status, await response.text()) };
    }
    return { ok: true, ...fields };
  } catch (err) {
    return {
      ok: false,
      ...fields,
      reason: `request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Read a model id out of CLI args. Backends pass their own flag spellings
 * because the same concept is `--model` for codex/claude and `-m` for gemini.
 */
export function readModelArg(args: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('-')) {
      return args[index + 1];
    }
    const inline = args.find((a) => a.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * OpenAI and OpenAI-shaped APIs (`Authorization: Bearer`).
 *
 * With a model, `GET /models/<id>` answers per model — 200 when the key may
 * use it, 404 when the account cannot see it, 401 when the key is rejected —
 * so this confirms entitlement rather than merely that the key parses. Without
 * one it degrades to the listing, which still settles auth.
 */
export async function checkOpenAiCredential(input: {
  baseUrl: string;
  model?: string;
  apiKey: string;
  credentialSource: string;
  timeoutMs: number;
}): Promise<CredentialProbeResult> {
  const base = input.baseUrl.replace(/\/$/, '');
  const endpoint = input.model ? `${base}/models/${encodeURIComponent(input.model)}` : `${base}/models`;
  const result = await getModelMetadata(endpoint, { Authorization: `Bearer ${input.apiKey}` }, input.timeoutMs);
  const fields = { credentialSource: input.credentialSource, endpoint, model: input.model };
  return result.ok ? { ok: true, ...fields } : { ok: false, ...fields, reason: result.reason };
}

/**
 * Anthropic and Anthropic-compatible endpoints that implement the model
 * listing (Anthropic itself, MiniMax's `/anthropic` façade).
 *
 * Only auth is treated as pass/fail: the listing returns dated model ids while
 * templates commonly pin an alias, so a template's model missing from the list
 * is not evidence that the model is unusable.
 */
export async function checkAnthropicCredential(input: {
  baseUrl: string;
  apiKey: string;
  credentialSource: string;
  timeoutMs: number;
}): Promise<CredentialProbeResult> {
  const endpoint = `${input.baseUrl.replace(/\/$/, '')}/v1/models`;
  const result = await getModelMetadata(
    endpoint,
    { 'x-api-key': input.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    input.timeoutMs,
  );
  return result.ok
    ? { ok: true, credentialSource: input.credentialSource, endpoint }
    : { ok: false, credentialSource: input.credentialSource, endpoint, reason: result.reason };
}

/**
 * Google Generative Language API. Like OpenAI this answers per model, so a
 * template pinning a retired Gemini model fails here rather than at dispatch.
 * An invalid key returns 400 rather than 401 — `describeFailure` surfaces the
 * provider's own wording either way.
 */
export async function checkGeminiCredential(input: {
  baseUrl: string;
  model?: string;
  apiKey: string;
  credentialSource: string;
  timeoutMs: number;
}): Promise<CredentialProbeResult> {
  const base = input.baseUrl.replace(/\/$/, '');
  const endpoint = input.model ? `${base}/models/${encodeURIComponent(input.model)}` : `${base}/models`;
  const result = await getModelMetadata(endpoint, { 'x-goog-api-key': input.apiKey }, input.timeoutMs);
  const fields = { credentialSource: input.credentialSource, endpoint, model: input.model };
  return result.ok ? { ok: true, ...fields } : { ok: false, ...fields, reason: result.reason };
}

interface ClaudeOAuthCredentials {
  claudeAiOauth?: {
    expiresAt?: number;
    refreshTokenExpiresAt?: number;
    subscriptionType?: string;
  };
}

/**
 * Claude Code subscription login, which stores an OAuth pair rather than an
 * API key. There is no free endpoint that validates a subscription token, so
 * the check is local: the login is usable while either token is unexpired,
 * because the CLI silently exchanges the refresh token when the access token
 * has lapsed. Only both being expired means the worker will fail to start.
 */
export async function checkClaudeOAuthLogin(input: {
  credentialsPath: string;
  now: number;
}): Promise<CredentialProbeResult> {
  const credentialSource = input.credentialsPath;
  let parsed: ClaudeOAuthCredentials;
  try {
    parsed = JSON.parse(await readFile(input.credentialsPath, 'utf-8')) as ClaudeOAuthCredentials;
  } catch (err) {
    const detail = err instanceof Error && 'code' in err && err.code === 'ENOENT' ? 'not found' : 'unreadable';
    return {
      ok: false,
      credentialSource,
      reason: `no API key in template.env and the Claude Code login is ${detail} — run \`claude login\``,
    };
  }

  const oauth = parsed.claudeAiOauth;
  if (!oauth) {
    return { ok: false, credentialSource, reason: 'credentials file has no claudeAiOauth entry — run `claude login`' };
  }

  const accessValid = typeof oauth.expiresAt === 'number' && oauth.expiresAt > input.now;
  const refreshValid = typeof oauth.refreshTokenExpiresAt === 'number' && oauth.refreshTokenExpiresAt > input.now;
  if (!accessValid && !refreshValid) {
    return { ok: false, credentialSource, reason: 'Claude Code login has expired — run `claude login`' };
  }

  const plan = oauth.subscriptionType ? ` (${oauth.subscriptionType})` : '';
  return { ok: true, credentialSource: `${credentialSource}${plan}` };
}
