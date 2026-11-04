/**
 * ClusterClient — the bot's HTTP client for the cluster daemon.
 *
 * The daemon serves the bot's former in-process cluster API unchanged (`/api/cluster/*`,
 * `/api/tickets/*`, the `@qqbot/api-types` shapes) behind a bearer token, plus `GET /health`.
 * Everything the bot asks of the cluster goes through here: the `/cluster` command, the agenda
 * ticket dispatcher, owner escalation (SSE) and the WebUI proxy backends.
 *
 * Registered under `DITokens.CLUSTER_CLIENT` only when `clusterClient` is configured, so
 * consumers gate on `isRegistered` first.
 */

import type { WorkerProbeResult } from '@qqbot/agent-cluster';
import type {
  ClusterDaemonHealthResponse,
  ClusterHelpAnsweredResponse,
  ClusterHelpRequest,
  ClusterJob,
  ClusterJobSubmitBody,
  ClusterPausedResponse,
  ClusterStatusResponse,
  ClusterTask,
  ClusterTemplatesResponse,
  ErrorResponse,
  Ticket,
  TicketCreateBody,
  TicketDeletedResponse,
  TicketFrontmatter,
  TicketsListResponse,
  TicketUpdateBody,
} from '@qqbot/api-types';
import { BotError, ConfigError, logger } from '@qqbot/shared';
import { inject, singleton } from 'tsyringe';
import type { Config } from '@/core/config';
import { DITokens } from '@/core/DITokens';

/** One event off the daemon's `GET /api/cluster/stream`; `data` is the parsed JSON payload. */
export interface ClusterEvent {
  event: string;
  data: unknown;
}

/** The daemon answered with an error status, or could not be reached (`status` is then null). */
export class ClusterClientError extends BotError {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message, 'CLUSTER_CLIENT_ERROR');
    this.name = 'ClusterClientError';
  }
}

const TAG = '[ClusterClient]';
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 120_000;
const RECONNECT_DELAY_MS = 5_000;
/** Response headers passed through the proxy; the rest are hop-by-hop or the daemon's own CORS. */
const PROXIED_RESPONSE_HEADERS = ['content-type', 'cache-control'];

@singleton()
export class ClusterClient {
  readonly url: string;
  private readonly token: string;

  constructor(@inject(DITokens.CONFIG) config: Config) {
    const cfg = config.getClusterClientConfig();
    if (!cfg) {
      throw new ConfigError('clusterClient is not configured');
    }
    this.url = cfg.url.replace(/\/+$/, '');
    this.token = cfg.token;
  }

  // ── Daemon ──

  health(): Promise<ClusterDaemonHealthResponse> {
    return this.json<ClusterDaemonHealthResponse>('GET', '/health');
  }

  // ── Cluster control ──

  getStatus(): Promise<ClusterStatusResponse> {
    return this.json<ClusterStatusResponse>('GET', '/api/cluster/status');
  }

  async isStarted(): Promise<boolean> {
    return (await this.getStatus()).started;
  }

  async pause(): Promise<void> {
    await this.json<ClusterPausedResponse>('POST', '/api/cluster/pause');
  }

  async resume(): Promise<void> {
    await this.json<ClusterPausedResponse>('POST', '/api/cluster/resume');
  }

  getTemplates(): Promise<ClusterTemplatesResponse> {
    return this.json<ClusterTemplatesResponse>('GET', '/api/cluster/templates');
  }

  submitTask(
    project: string,
    description: string,
    options?: Omit<ClusterJobSubmitBody, 'project' | 'description'>,
  ): Promise<ClusterTask> {
    const body: ClusterJobSubmitBody = { project, description, ...options };
    return this.json<ClusterTask>('POST', '/api/cluster/jobs', body);
  }

  async getJob(jobId: string): Promise<ClusterJob | null> {
    return this.orNull(this.json<ClusterJob>('GET', `/api/cluster/jobs/${encodeURIComponent(jobId)}`));
  }

  getPendingHelpRequests(): Promise<ClusterHelpRequest[]> {
    return this.json<ClusterHelpRequest[]>('GET', '/api/cluster/help');
  }

  async answerHelpRequest(askId: string, answer: string, answeredBy: string): Promise<boolean> {
    const res = await this.json<ClusterHelpAnsweredResponse>(
      'POST',
      `/api/cluster/help/${encodeURIComponent(askId)}/answer`,
      { answer, answeredBy },
    );
    return res.answered;
  }

  /** `POST /api/cluster/probe` — the daemon checks each worker template's provider credentials. */
  probeWorkerTemplates(opts?: { templates?: string[] }): Promise<WorkerProbeResult[]> {
    return this.json<WorkerProbeResult[]>('POST', '/api/cluster/probe', opts ?? {}, PROBE_TIMEOUT_MS);
  }

  // ── Tickets ──

  async listTickets(): Promise<TicketFrontmatter[]> {
    return (await this.json<TicketsListResponse>('GET', '/api/tickets')).tickets;
  }

  getTicket(id: string): Promise<Ticket | null> {
    return this.orNull(this.json<Ticket>('GET', `/api/tickets/${encodeURIComponent(id)}`));
  }

  createTicket(body: TicketCreateBody): Promise<Ticket> {
    return this.json<Ticket>('POST', '/api/tickets', body);
  }

  updateTicket(id: string, patch: TicketUpdateBody): Promise<Ticket> {
    return this.json<Ticket>('PUT', `/api/tickets/${encodeURIComponent(id)}`, patch);
  }

  async deleteTicket(id: string): Promise<boolean> {
    const res = await this.orNull(this.json<TicketDeletedResponse>('DELETE', `/api/tickets/${encodeURIComponent(id)}`));
    return res?.deleted ?? false;
  }

  // ── Pass-through ──

  /**
   * Forward `req` to the daemon at `pathWithQuery` and hand back its response as is, body
   * streaming (so `/api/cluster/stream` passes through). The daemon's bearer token is added;
   * the bot's own static-server CORS headers are applied by its caller.
   */
  async proxy(req: Request, pathWithQuery: string): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    for (const name of ['content-type', 'accept']) {
      const value = req.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let upstream: Response;
    try {
      upstream = await fetch(`${this.url}${pathWithQuery}`, {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      const body: ErrorResponse = { error: `cluster daemon unreachable at ${this.url}: ${describe(err)}` };
      return Response.json(body, { status: 503 });
    }
    const out = new Headers();
    for (const name of PROXIED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) {
        out.set(name, value);
      }
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  // ── Events ──

  /**
   * Follow the daemon's SSE stream until `signal` aborts, reconnecting 5s after any failure or
   * end of stream. `onConnect` runs on every (re)connection, so a consumer can reconcile what
   * it missed while disconnected.
   */
  async events(onEvent: (event: ClusterEvent) => void, signal: AbortSignal, onConnect?: () => void): Promise<void> {
    let down = false;
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.url}/api/cluster/stream`, {
          headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok || !res.body) {
          throw new ClusterClientError(`GET /api/cluster/stream answered ${res.status}`, res.status);
        }
        if (down) {
          logger.info(`${TAG} reconnected to ${this.url}`);
          down = false;
        }
        onConnect?.();
        await readEventStream(res.body, onEvent, signal);
        if (!signal.aborted) {
          logger.warn(`${TAG} event stream ended; reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        if (!down) {
          logger.warn(
            `${TAG} event stream unavailable (${describe(err)}); retrying every ${RECONNECT_DELAY_MS / 1000}s`,
          );
        }
        down = true;
      }
      await sleep(RECONNECT_DELAY_MS, signal);
    }
  }

  // ── HTTP ──

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ClusterClientError(`cluster daemon unreachable at ${this.url}: ${describe(err)}`, null);
    }
    if (!res.ok) {
      throw new ClusterClientError(`${method} ${path}: ${res.status} ${await errorText(res)}`, res.status);
    }
    return (await res.json()) as T;
  }

  private async orNull<T>(request: Promise<T>): Promise<T | null> {
    try {
      return await request;
    } catch (err) {
      if (err instanceof ClusterClientError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as Partial<ErrorResponse>;
    if (typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // not JSON
  }
  return text || res.statusText;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Parse an SSE body (text/event-stream) into events until it ends or `signal` aborts. Blocks are
 * separated by a blank line; `event:` names the event, `data:` lines are joined with newlines
 * and parsed as JSON (left as the raw string when they are not JSON).
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ClusterEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = parseEventBlock(block);
        if (event) {
          onEvent(event);
        }
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): ClusterEvent | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length === 0) {
    return null;
  }
  const raw = data.join('\n');
  try {
    return { event: name, data: JSON.parse(raw) };
  } catch {
    return { event: name, data: raw };
  }
}
