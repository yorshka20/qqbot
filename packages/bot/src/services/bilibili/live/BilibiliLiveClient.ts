// BilibiliLiveClient — connects to a Bilibili live room's danmaku WebSocket,
// emits parsed events, and exposes a one-shot `sendDanmaku` REST method.
//
// Lifecycle:
//   start() → fetch danmu_info (token + host_list) → open WSS → auth packet →
//   30s heartbeat loop → decode incoming frames → emit typed events.
//
// Reconnect: on close/error, exponential backoff up to ~60s, indefinite.
//
// The receive side is anonymous-viewer friendly (works without SESSDATA at
// lower rate limits). `sendDanmaku` requires both SESSDATA and bili_jct
// (CSRF), and is gated behind an explicit `send.enabled` config flag — the
// method no-ops with a warn if either is missing.

import { EventEmitter } from 'node:events';
import { logger } from '@/utils/logger';
import {
  decodeAll,
  decodeBodyJson,
  decodeOnlineCount,
  encodePacket,
  Op,
  Protover,
} from './protocol';

export interface BilibiliLiveClientOptions {
  roomId: number;
  sessdata?: string;
  biliJct?: string;
  /** Heartbeat interval in ms (default 30_000). */
  heartbeatIntervalMs?: number;
  /** Reconnect initial backoff in ms (default 1_000). */
  reconnectInitialMs?: number;
  /** Reconnect max backoff in ms (default 60_000). */
  reconnectMaxMs?: number;
  /** Whether sendDanmaku() is allowed; default false. Receiving works either way. */
  sendEnabled?: boolean;
}

export interface DanmakuEvent {
  uid: string;
  username: string;
  text: string;
  medalName?: string;
  medalLevel?: number;
  guardLevel?: number;
  /** Server-side timestamp in ms when available, else client receive time. */
  timestamp: number;
}

interface DanmuInfoHost {
  host: string;
  port: number;
  wss_port: number;
  ws_port: number;
}

interface DanmuInfoResponse {
  code: number;
  message?: string;
  data?: {
    token: string;
    host_list: DanmuInfoHost[];
  };
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Parse a DANMU_MSG `info` array into the shape our pipeline consumes.
 * The upstream schema is loosely typed and occasionally mutates between
 * bilibili releases, so every field access is defensive.
 */
function parseDanmuMsg(info: unknown): DanmakuEvent | null {
  if (!Array.isArray(info) || info.length < 3) return null;
  const meta = Array.isArray(info[0]) ? info[0] : [];
  const text = typeof info[1] === 'string' ? info[1] : '';
  const sender = Array.isArray(info[2]) ? info[2] : [];
  const medal = Array.isArray(info[3]) ? info[3] : [];

  if (!text) return null;
  const uid = sender[0] != null ? String(sender[0]) : '';
  const username = typeof sender[1] === 'string' ? sender[1] : '';
  if (!uid) return null;

  // meta[4] is often the server-side send timestamp (ms).
  const ts = typeof meta[4] === 'number' && meta[4] > 0 ? Number(meta[4]) : Date.now();

  // Guard level surfaces at info[7] in most releases; tolerate absence.
  const guardLevelRaw = info[7];
  const guardLevel = typeof guardLevelRaw === 'number' && guardLevelRaw > 0 ? guardLevelRaw : undefined;

  const medalLevel = typeof medal[0] === 'number' && medal[0] > 0 ? medal[0] : undefined;
  const medalName = typeof medal[1] === 'string' && medal[1].length > 0 ? medal[1] : undefined;

  return {
    uid,
    username,
    text,
    medalLevel,
    medalName,
    guardLevel,
    timestamp: ts,
  };
}

export interface BilibiliLiveClientEvents {
  open: () => void;
  close: (reason: string) => void;
  error: (err: Error) => void;
  danmaku: (evt: DanmakuEvent) => void;
  online: (count: number) => void;
  raw: (cmd: string, payload: unknown) => void;
}

export declare interface BilibiliLiveClient {
  on<K extends keyof BilibiliLiveClientEvents>(event: K, listener: BilibiliLiveClientEvents[K]): this;
  emit<K extends keyof BilibiliLiveClientEvents>(event: K, ...args: Parameters<BilibiliLiveClientEvents[K]>): boolean;
  off<K extends keyof BilibiliLiveClientEvents>(event: K, listener: BilibiliLiveClientEvents[K]): this;
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: EventEmitter typed-event pattern
export class BilibiliLiveClient extends EventEmitter {
  private readonly opts: Required<Omit<BilibiliLiveClientOptions, 'sessdata' | 'biliJct'>> &
    Pick<BilibiliLiveClientOptions, 'sessdata' | 'biliJct'>;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** User-initiated stop; suppresses reconnect. */
  private stopped = false;
  private currentBackoffMs = 0;

  constructor(options: BilibiliLiveClientOptions) {
    super();
    this.opts = {
      roomId: options.roomId,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      reconnectInitialMs: options.reconnectInitialMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 60_000,
      sendEnabled: options.sendEnabled ?? false,
      sessdata: options.sessdata,
      biliJct: options.biliJct,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private async connectOnce(): Promise<void> {
    try {
      const info = await this.fetchDanmuInfo();
      if (!info.data?.token || !info.data.host_list?.length) {
        throw new Error(`getDanmuInfo returned no token/hosts: code=${info.code} message=${info.message}`);
      }
      const host = info.data.host_list[0];
      const url = `wss://${host.host}:${host.wss_port}/sub`;
      logger.info(`[BilibiliLive] Connecting to ${url} (room=${this.opts.roomId})`);

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.addEventListener('open', () => this.onOpen(info.data!.token));
      ws.addEventListener('message', (ev) => this.onMessage(ev));
      ws.addEventListener('close', (ev) => this.onClose(ev));
      ws.addEventListener('error', () => this.onError(new Error('WebSocket error')));
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }

  private async fetchDanmuInfo(): Promise<DanmuInfoResponse> {
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${this.opts.roomId}&type=0`;
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: `https://live.bilibili.com/${this.opts.roomId}`,
      Origin: 'https://live.bilibili.com',
    };
    if (this.opts.sessdata) {
      headers.Cookie = `SESSDATA=${this.opts.sessdata}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`getDanmuInfo HTTP ${resp.status}`);
    return (await resp.json()) as DanmuInfoResponse;
  }

  private onOpen(token: string): void {
    this.reconnectAttempts = 0;
    this.currentBackoffMs = 0;

    // Auth packet: protover=3 requests brotli-compressed business frames.
    // `uid=0` is the anonymous-viewer convention — Bilibili accepts this
    // even without SESSDATA; with SESSDATA set, we still send 0 because
    // deriving the real uid adds a network hop (nav) for no receive-side
    // benefit.
    const auth = {
      uid: 0,
      roomid: this.opts.roomId,
      protover: Protover.BROTLI,
      platform: 'web',
      type: 2,
      key: token,
    };
    this.send(encodePacket(Op.AUTH, auth));

    this.startHeartbeat();
    this.emit('open');
  }

  private onMessage(ev: MessageEvent): void {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer)) return;
    const buf = Buffer.from(data);
    let frames;
    try {
      frames = decodeAll(buf);
    } catch (err) {
      logger.warn('[BilibiliLive] frame decode failed:', err);
      return;
    }
    for (const frame of frames) {
      this.dispatchFrame(frame);
    }
  }

  private dispatchFrame(frame: ReturnType<typeof decodeAll>[number]): void {
    switch (frame.op) {
      case Op.HEARTBEAT_REPLY: {
        this.emit('online', decodeOnlineCount(frame));
        return;
      }
      case Op.AUTH_REPLY: {
        const body = decodeBodyJson<{ code?: number }>(frame);
        if (body?.code !== 0) {
          logger.warn(`[BilibiliLive] auth reply non-zero: ${JSON.stringify(body)}`);
        } else {
          logger.info('[BilibiliLive] Auth OK');
        }
        return;
      }
      case Op.MESSAGE: {
        const payload = decodeBodyJson<{ cmd?: string; info?: unknown }>(frame);
        if (!payload || typeof payload.cmd !== 'string') return;
        this.emit('raw', payload.cmd, payload);
        if (payload.cmd === 'DANMU_MSG') {
          const evt = parseDanmuMsg(payload.info);
          if (evt) this.emit('danmaku', evt);
        }
        return;
      }
      default:
        return;
    }
  }

  private onClose(ev: CloseEvent): void {
    this.stopHeartbeat();
    this.ws = null;
    const reason = ev?.reason || `code=${ev?.code ?? 'unknown'}`;
    this.emit('close', reason);
    if (!this.stopped) this.scheduleReconnect();
  }

  private onError(err: Error): void {
    this.emit('error', err);
    // `close` will follow — reconnect is scheduled there.
  }

  private send(packet: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Bun's WebSocket.send accepts Buffer/Uint8Array/ArrayBuffer.
    this.ws.send(packet);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.send(encodePacket(Op.HEARTBEAT, ''));
      } catch (err) {
        logger.warn('[BilibiliLive] heartbeat send failed:', err);
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const base = this.opts.reconnectInitialMs;
    const max = this.opts.reconnectMaxMs;
    // Exponential backoff with modest jitter (±20%) to avoid thundering-herd
    // on a flapping endpoint. Caps at `reconnectMaxMs`.
    const exp = Math.min(max, base * 2 ** Math.min(10, this.reconnectAttempts - 1));
    const jitter = exp * (0.8 + Math.random() * 0.4);
    this.currentBackoffMs = Math.floor(jitter);
    logger.info(
      `[BilibiliLive] reconnect attempt ${this.reconnectAttempts} in ${this.currentBackoffMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, this.currentBackoffMs);
  }

  /**
   * Send a danmaku message to the live room. Requires both SESSDATA and
   * bili_jct (CSRF token) to be configured, and `sendEnabled=true`. Throws
   * when credentials are missing or the API returns a non-zero code so
   * callers (future /livedm command) can surface the failure to the user.
   */
  async sendDanmaku(text: string, opts?: { color?: number; mode?: number; fontsize?: number }): Promise<void> {
    if (!this.opts.sendEnabled) {
      throw new Error('sendDanmaku disabled by config (bilibili.live.send.enabled=false)');
    }
    if (!this.opts.sessdata || !this.opts.biliJct) {
      throw new Error('sendDanmaku requires bilibili.live.sessdata and bilibili.live.biliJct');
    }
    const body = new URLSearchParams({
      bubble: '0',
      msg: text,
      color: String(opts?.color ?? 16777215),
      mode: String(opts?.mode ?? 1),
      fontsize: String(opts?.fontsize ?? 25),
      rnd: String(Math.floor(Date.now() / 1000)),
      roomid: String(this.opts.roomId),
      csrf: this.opts.biliJct,
      csrf_token: this.opts.biliJct,
    });
    const resp = await fetch('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: `https://live.bilibili.com/${this.opts.roomId}`,
        Origin: 'https://live.bilibili.com',
        Cookie: `SESSDATA=${this.opts.sessdata}; bili_jct=${this.opts.biliJct}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!resp.ok) throw new Error(`sendDanmaku HTTP ${resp.status}`);
    const json = (await resp.json()) as { code?: number; message?: string };
    if (json.code !== 0) {
      throw new Error(`sendDanmaku failed: code=${json.code} message=${json.message}`);
    }
  }
}
