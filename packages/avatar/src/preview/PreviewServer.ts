/**
 * Avatar Preview Server — serves a static preview page over HTTP and streams
 * Live2D parameter/status updates over WebSocket on the same Bun server.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from 'bun';
import type { IdleClip } from '../compiler/layers/clips/types';
import type { ActionSummary } from '../compiler/types';
import { logger } from '../utils/logger';
import type {
  AudioMessage,
  ModelKind,
  PreviewClientMessage,
  PreviewConfig,
  PreviewFrame,
  PreviewMessage,
  PreviewStatus,
  TunableSection,
} from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CONFIG: PreviewConfig = {
  port: 8002,
  host: '0.0.0.0',
};

export interface PreviewServerHandlers {
  onTrigger?: (data: { action: string; emotion?: string; intensity?: number }) => void;
  /**
   * Called after every WS client open/close with the new total client count.
   * Lets callers gate expensive downstream work (frame computation, layer
   * sampling) on the presence of actual consumers.
   */
  onClientCountChange?: (count: number) => void;
  /**
   * Pulled by the HTTP `/action-map` endpoint to enumerate the currently
   * loaded action set — so UIs (HUD, future tooling) can render triggers
   * dynamically instead of hardcoding names. Absent handler → 404.
   */
  getActionList?: () => ActionSummary[];
  /**
   * Called when the HUD sends a `{type:'speak'}` debug message. Bypasses
   * the LLM reply path — bot synthesizes + broadcasts the provided text
   * exactly as if it came from `Live2DAvatarPlugin.onMessageBeforeSend`.
   */
  onSpeak?: (data: { text: string }) => void;
  onAmbientAudio?: (data: { rms: number; tMs: number }) => void;
  /**
   * HUD requested the current list of tunable params. Return value is
   * serialized into a `tunable-params` response and sent to the requesting
   * socket only (not broadcast).
   */
  onTunableParamsRequest?: () => TunableSection[];
  /**
   * HUD dragged a slider. Fire-and-forget (no ack). Implementations are
   * expected to be cheap — this runs per slider tick (~50ms).
   */
  onTunableParamSet?: (data: { sectionId: string; paramId: string; value: number }) => void;
  /**
   * Returns the first preloaded IdleClip for a clip-kind action, or null if
   * the action is non-clip or unknown. Drives the `/clip/:name` debug route.
   */
  getClipByActionName?: (name: string) => IdleClip | null;
  /**
   * Called when the renderer sends a valid `hello` message declaring its
   * model format. `kind` is null when the renderer has no model loaded.
   * Old renderers that never send hello leave the compiler state as null
   * (backward compatible default).
   */
  onModelKindChange?: (kind: ModelKind | null) => void;
}

export class PreviewServer {
  private readonly config: PreviewConfig;
  private readonly handlers: PreviewServerHandlers;
  private server: ReturnType<typeof serve> | null = null;
  private clients = new Set<import('bun').ServerWebSocket<unknown>>();
  private latestStatus: PreviewStatus | null = null;

  constructor(config?: Partial<PreviewConfig>, handlers: PreviewServerHandlers = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const { port, host } = this.config;
    const clients = this.clients;
    const server = this;

    this.server = serve({
      port,
      hostname: host,
      idleTimeout: 255,
      fetch(req, srv) {
        // Try WebSocket upgrade first — upgrade requests hit "/" too, so
        // pathname routing would otherwise shadow them with the HTML response.
        if (srv.upgrade(req, { data: undefined })) {
          return undefined;
        }

        const url = new URL(req.url);

        if (url.pathname === '/') {
          const htmlPath = join(__dirname, 'client', 'index.html');
          const html = readFileSync(htmlPath, 'utf-8');
          return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ status: 'ok', clients: clients.size }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const clipMatch = url.pathname.match(/^\/clip\/([^/]+)$/);
        if (clipMatch) {
          const name = decodeURIComponent(clipMatch[1]);
          const clip = server.handlers.getClipByActionName?.(name) ?? null;
          if (!clip)
            return new Response(JSON.stringify({ error: 'not_found', name }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
          return new Response(JSON.stringify(clip), { headers: { 'content-type': 'application/json' } });
        }

        if (url.pathname === '/action-map') {
          const list = server.handlers.getActionList?.();
          if (!list) return new Response('action-list unavailable', { status: 404 });
          return new Response(JSON.stringify(list), {
            headers: {
              'Content-Type': 'application/json',
              // HUD fetches on mount; allow a short cache so quick reloads
              // during local dev don't re-hit the bot. No revalidation — a
              // full page refresh is fine to pick up changes.
              'Cache-Control': 'public, max-age=5',
              // Renderer runs on a different origin during `vite dev`
              // (localhost:5173) so allow simple GETs from anywhere.
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          clients.add(ws);
          server.handlers.onClientCountChange?.(clients.size);
          // Send latest cached status to new client
          if (server.latestStatus !== null) {
            const msg: PreviewMessage = { type: 'status', data: server.latestStatus };
            ws.send(JSON.stringify(msg));
          }
        },
        message(_ws, message) {
          // Expect only string messages containing a JSON object with type:'trigger'
          const rawMessage = typeof message === 'string' ? message : Buffer.from(message).toString('utf-8');
          let msg: PreviewClientMessage;
          try {
            msg = JSON.parse(rawMessage) as PreviewClientMessage;
          } catch {
            // JSON parse failure — silent drop
            return;
          }

          if (msg.type === 'trigger') {
            if (!msg.data) return;
            if (typeof msg.data.action !== 'string' || msg.data.action === '') return;

            const data = msg.data;
            const sanitized: { action: string; emotion?: string; intensity?: number } = {
              action: data.action,
            };
            if (typeof data.emotion === 'string') {
              sanitized.emotion = data.emotion;
            }
            if (typeof data.intensity === 'number' && Number.isFinite(data.intensity)) {
              sanitized.intensity = data.intensity;
            }

            server.handlers.onTrigger?.(sanitized);
            logger.debug('[PreviewServer] Trigger received', {
              action: sanitized.action,
              emotion: sanitized.emotion,
              intensity: sanitized.intensity,
            });
            return;
          }

          if (msg.type === 'speak') {
            if (!msg.data) return;
            const text = typeof msg.data.text === 'string' ? msg.data.text.trim() : '';
            if (text.length === 0) return;
            server.handlers.onSpeak?.({ text });
            logger.info(`[PreviewServer] Speak received (debug) — len=${text.length}`);
            return;
          }

          if (msg.type === 'ambient-audio') {
            if (!msg.data) return;
            const rms = typeof msg.data.rms === 'number' && Number.isFinite(msg.data.rms) ? msg.data.rms : null;
            const tMs = typeof msg.data.tMs === 'number' && Number.isFinite(msg.data.tMs) ? msg.data.tMs : null;
            if (rms === null || tMs === null) return;
            // Clamp rms to [0, 10] as a sanity guard; normal range is [0, ~1]
            const rmsClamped = Math.max(0, Math.min(10, rms));
            server.handlers.onAmbientAudio?.({ rms: rmsClamped, tMs });
            return;
          }

          if (msg.type === 'tunable-params-request') {
            const sections = server.handlers.onTunableParamsRequest?.();
            if (!sections) return;
            const response: PreviewMessage = { type: 'tunable-params', data: { sections } };
            _ws.send(JSON.stringify(response));
            return;
          }

          if (msg.type === 'tunable-param-set') {
            if (!msg.data) return;
            const { sectionId, paramId, value } = msg.data;
            if (typeof sectionId !== 'string' || typeof paramId !== 'string') return;
            if (typeof value !== 'number' || !Number.isFinite(value)) return;
            server.handlers.onTunableParamSet?.({ sectionId, paramId, value });
            return;
          }

          if (msg.type === 'hello') {
            const { modelKind } = msg;
            // Validate modelKind: must be 'cubism', 'vrm', or null.
            if (modelKind !== 'cubism' && modelKind !== 'vrm' && modelKind !== null) {
              logger.warn(`[PreviewServer] hello received with invalid modelKind="${modelKind}" — ignored`);
              return;
            }
            server.handlers.onModelKindChange?.(modelKind);
            logger.info(`[PreviewServer] hello received — modelKind=${modelKind ?? 'null'}`);
            return;
          }
          // Unknown type — silent drop
        },
        close(ws) {
          clients.delete(ws);
          server.handlers.onClientCountChange?.(clients.size);
        },
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.server.stop();
    this.server = null;
  }

  broadcastAudio(msg: AudioMessage): void {
    const text = JSON.stringify(msg);
    for (const client of this.clients) {
      try {
        client.send(text);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  broadcastFrame(frame: PreviewFrame): void {
    const msg: PreviewMessage = { type: 'frame', data: frame };
    const text = JSON.stringify(msg);
    for (const client of this.clients) {
      try {
        client.send(text);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  updateStatus(status: PreviewStatus): void {
    this.latestStatus = status;
    const msg: PreviewMessage = { type: 'status', data: status };
    const text = JSON.stringify(msg);
    for (const client of this.clients) {
      try {
        client.send(text);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
