// BilibiliLiveClient — hand-rolled WebSocket client for Bilibili's live
// danmaku WS endpoint.
//
// Earlier in this project's history we briefly used the `bilibili-live-ws`
// npm package, but ended up needing to override almost everything it does
// (its default `getConf` is unsigned and hits `-352`, its auth packet
// hardcodes `platform: 'web'` which bilibili's risk control rejects for
// non-browser clients). Once the real fix was identified — auth-packet
// `platform: 'danmuji'` and our own WBI-signed `getDanmuInfo` — the
// library's value dropped to ~60 lines of binary-frame decoding that we
// already had tests for.
//
// What this file owns, top to bottom:
//   - WBI-signed `getDanmuInfo` to obtain a valid token (library's bare
//     fetch fails under modern risk control)
//   - Browser-fingerprint cookies (`buvid3`) from the spi endpoint
//   - Auth packet with `platform: 'danmuji'` (matches the long-running C#
//     reference client `bililive_dm` — on bilibili's third-party whitelist)
//   - WS connect → auth → 30s heartbeat loop → frame dispatch
//   - Exponential-backoff reconnect with a hard cap (3 pre-auth failures →
//     stop, require explicit `/live2d reconnect`)
//   - `sendDanmaku` via REST (receive-only clients don't need this)

import { EventEmitter } from 'node:events';
import { logger } from '@/utils/logger';
import { clearWbiCache, signWbiParams } from '../wbi';
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
  /** Hard cap on consecutive pre-auth failures before stopping. Default 3. */
  maxReconnectAttempts?: number;
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
 * Normalize a raw SESSDATA value to the URL-encoded form browsers send in
 * Cookie headers. Bilibili's 2024+ format contains literal `,` and `*` as
 * structural delimiters; DevTools shows the decoded form, but Cookie
 * transport expects `%2C` / `%2A`. Idempotent: already-encoded input passes
 * through untouched.
 */
function normalizeSessdata(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  return raw.replace(/,/g, '%2C').replace(/\*/g, '%2A');
}

/**
 * Parse a DANMU_MSG `info` array into the shape our pipeline consumes. The
 * upstream schema is loosely typed and occasionally mutates between bilibili
 * releases, so every field access is defensive.
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

  return { uid, username, text, medalLevel, medalName, guardLevel, timestamp: ts };
}

export interface BilibiliLiveClientEvents {
  /** WS handshake done. Auth packet sent but not yet replied. */
  open: () => void;
  /** Auth succeeded (AUTH_REPLY with code=0). Real "connected" signal. */
  live: () => void;
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
  private readonly opts: Required<
    Pick<
      BilibiliLiveClientOptions,
      'roomId' | 'heartbeatIntervalMs' | 'reconnectInitialMs' | 'reconnectMaxMs' | 'maxReconnectAttempts' | 'sendEnabled'
    >
  > &
    Pick<BilibiliLiveClientOptions, 'sessdata' | 'biliJct'>;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private exhausted = false;
  /**
   * Flipped to `true` on AUTH_REPLY code=0 (real auth success); reset on
   * every fresh connection attempt. The close handler consults this to
   * distinguish pre-auth failures (count toward the cap) from post-auth
   * disconnects (don't count — normal churn).
   */
  private authedThisSession = false;
  private cachedBuvid: { b3: string; b4: string } | null = null;

  constructor(options: BilibiliLiveClientOptions) {
    super();
    const rawSessdata = options.sessdata;
    const normalized = normalizeSessdata(rawSessdata);
    if (rawSessdata && normalized !== rawSessdata) {
      logger.info('[BilibiliLive] SESSDATA auto-normalized (URL-encoded `,` and `*` for Cookie transport)');
    }
    if (rawSessdata) {
      logger.info(
        '[BilibiliLive] SESSDATA configured but only used for sendDanmaku — WS receive path runs anonymous (platform=danmuji)',
      );
    }
    this.opts = {
      roomId: options.roomId,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      reconnectInitialMs: options.reconnectInitialMs ?? 1_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 60_000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
      sendEnabled: options.sendEnabled ?? false,
      sessdata: normalized,
      biliJct: options.biliJct,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.exhausted = false;
    this.reconnectAttempts = 0;
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

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authedThisSession;
  }

  isReconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  isExhausted(): boolean {
    return this.exhausted;
  }

  // ── Connection lifecycle ────────────────────────────────────────

  private async connectOnce(): Promise<void> {
    this.authedThisSession = false;
    try {
      // WBI-signed fetch is mandatory under current risk control — plain
      // `getDanmuInfo` returns code=-352 without proper signature + cookies.
      const info = await this.fetchDanmuInfo();
      const token = info.data?.token;
      if (!token || !info.data?.host_list?.length) {
        const err = new Error(`getDanmuInfo failed: code=${info.code} message=${info.message}`);
        (err as Error & { bilibiliCode?: number }).bilibiliCode = info.code;
        throw err;
      }
      const host = info.data.host_list[0];
      const url = `wss://${host.host}:${host.wss_port}/sub`;
      const buvid = (await this.ensureBuvid()).b3;
      logger.info(
        `[BilibiliLive] connecting to ${url} (room=${this.opts.roomId}, buvid=${buvid ? `${buvid.slice(0, 8)}…` : 'EMPTY'})`,
      );

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.addEventListener('open', () => this.onOpen(token, buvid));
      ws.addEventListener('message', (ev) => this.onMessage(ev));
      ws.addEventListener('close', (ev) => this.onClose(ev));
      ws.addEventListener('error', () => this.onError(new Error('WebSocket error')));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.safeEmitError(e);
      this.scheduleReconnect((e as Error & { bilibiliCode?: number }).bilibiliCode);
    }
  }

  private onOpen(token: string, buvid: string): void {
    // DO NOT reset `reconnectAttempts` here — WS-open alone isn't success.
    // Only AUTH_REPLY code=0 (via `handleLive`) counts.
    //
    // Auth packet uses `platform: 'danmuji'` instead of `'web'` — matches
    // the long-running C# reference client `bililive_dm`. `'web'` triggers
    // bilibili's browser-fingerprint risk control (expects full browser WS
    // handshake with cookies), which kicks non-browser clients post-handshake
    // with no AUTH_REPLY frame.
    const auth = {
      uid: 0,
      roomid: this.opts.roomId,
      protover: Protover.BROTLI,
      buvid,
      platform: 'danmuji',
      type: 2,
      key: token,
    };
    const packet = encodePacket(Op.AUTH, auth);
    logger.info(
      `[BilibiliLive] auth packet sent (${packet.length} bytes, platform=danmuji buvid=${buvid ? `${buvid.slice(0, 8)}…` : 'EMPTY'})`,
    );
    this.send(packet);

    this.startHeartbeat();
    this.emit('open');
  }

  private handleAuthSuccess(): void {
    this.authedThisSession = true;
    this.reconnectAttempts = 0;
    logger.info(`[BilibiliLive] Auth OK (room=${this.opts.roomId})`);
    this.emit('live');
  }

  private onClose(ev: CloseEvent): void {
    this.stopHeartbeat();
    this.ws = null;
    const wasAuthed = this.authedThisSession;
    this.authedThisSession = false;

    const code = ev?.code ?? 'unknown';
    const reason = ev?.reason || '(no reason)';
    const tag = wasAuthed ? 'after auth' : 'pre-auth';
    const msg = `${tag}: code=${code} reason=${reason}`;
    this.emit('close', msg);

    if (this.stopped) return;

    // Only pre-auth disconnects count toward the cap. Post-auth disconnects
    // are normal churn (network blips, server rolls) and should reconnect
    // forever.
    if (!wasAuthed) {
      this.reconnectAttempts += 1;
    }
    this.scheduleReconnect();
  }

  private onError(err: Error): void {
    this.safeEmitError(err);
    // `close` follows — reconnect is scheduled there.
  }

  private safeEmitError(err: Error): void {
    logger.warn(`[BilibiliLive] ${err.message}`);
    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', err);
      } catch (emitErr) {
        logger.warn('[BilibiliLive] error listener threw:', emitErr);
      }
    }
  }

  private scheduleReconnect(bilibiliCode?: number): void {
    if (this.stopped) return;
    if (this.reconnectAttempts > this.opts.maxReconnectAttempts) {
      this.stopped = true;
      this.exhausted = true;
      clearWbiCache();
      logger.warn(
        `[BilibiliLive] Reconnect exhausted after ${this.opts.maxReconnectAttempts} pre-auth failures. Stopping. Use /live2d reconnect to retry.`,
      );
      this.safeEmitError(new Error(`reconnect exhausted (${this.opts.maxReconnectAttempts} attempts)`));
      return;
    }
    const base = this.opts.reconnectInitialMs;
    const max = this.opts.reconnectMaxMs;
    // Risk-control codes (-352 / -412) mean the server is actively rejecting
    // us. Floor to 60s to avoid deepening the block.
    const RISK_CONTROL_FLOOR_MS = 60_000;
    const isRiskControl = bilibiliCode === -352 || bilibiliCode === -412;
    const effectiveBase = isRiskControl ? Math.max(base, RISK_CONTROL_FLOOR_MS) : base;
    const exp = Math.min(max, effectiveBase * 2 ** Math.min(10, Math.max(0, this.reconnectAttempts - 1)));
    const jitter = exp * (0.8 + Math.random() * 0.4);
    const backoff = Math.floor(jitter);
    const tag = isRiskControl ? ` [risk-control code=${bilibiliCode}]` : '';
    logger.info(`[BilibiliLive] reconnect attempt ${this.reconnectAttempts} in ${backoff}ms${tag}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, backoff);
  }

  // ── Frame I/O ───────────────────────────────────────────────────

  private send(packet: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(packet);
  }

  private onMessage(ev: MessageEvent): void {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer)) return;
    const buf = Buffer.from(data);
    let frames: ReturnType<typeof decodeAll>;
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
      case Op.HEARTBEAT_REPLY:
        this.emit('online', decodeOnlineCount(frame));
        return;
      case Op.AUTH_REPLY: {
        const body = decodeBodyJson<{ code?: number }>(frame);
        if (body?.code !== 0) {
          logger.warn(`[BilibiliLive] auth reply non-zero: ${JSON.stringify(body)}`);
        } else {
          this.handleAuthSuccess();
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

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    // Send one immediately on connect — bilibili's ticker expects activity
    // within ~30s of auth, and waiting a full interval risks an idle-timeout
    // kick on slow networks.
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.opts.heartbeatIntervalMs);
  }

  private sendHeartbeat(): void {
    try {
      this.send(encodePacket(Op.HEARTBEAT, ''));
    } catch (err) {
      logger.warn('[BilibiliLive] heartbeat send failed:', err);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── REST: getDanmuInfo (signed) + spi buvid bootstrap ────────────

  private async fetchDanmuInfo(): Promise<DanmuInfoResponse> {
    const signedQuery = await signWbiParams({ id: this.opts.roomId, type: 0 });
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signedQuery}`;

    // DELIBERATELY do NOT send SESSDATA on the receive path. Bilibili's
    // risk control treats `SESSDATA-cookie + platform=danmuji-auth` as
    // contradictory ("claims to be third-party client but carries web
    // login session") and silently kicks the WS connection post-handshake
    // (manifests as code=1006 pre-auth). Empirically: clearing SESSDATA →
    // immediate Auth OK from the same IP/buvid.
    //
    // SESSDATA is still used by `sendDanmaku()` because POST /msg/send
    // requires authenticated session. That path uses platform=web semantics
    // and bilibili accepts SESSDATA there.
    const buvid = await this.ensureBuvid();
    const cookieParts: string[] = [];
    if (buvid.b3) cookieParts.push(`buvid3=${buvid.b3}`);
    if (buvid.b4) cookieParts.push(`buvid4=${buvid.b4}`);

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Referer: `https://live.bilibili.com/${this.opts.roomId}`,
      Origin: 'https://live.bilibili.com',
    };
    if (cookieParts.length > 0) headers.Cookie = cookieParts.join('; ');

    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`getDanmuInfo HTTP ${resp.status}`);
    const json = (await resp.json()) as DanmuInfoResponse;
    if (json.code === -352) {
      // Stale WBI keys — bust so a subsequent reconnect gets fresh ones.
      clearWbiCache();
    }
    return json;
  }

  /**
   * Fetch (and cache for this client's lifetime) bilibili's `buvid3` /
   * `buvid4` browser-fingerprint cookies. The endpoint is explicitly
   * cookie-bootstrap — no auth, fresh pair per call.
   */
  private async ensureBuvid(): Promise<{ b3: string; b4: string }> {
    if (this.cachedBuvid) return this.cachedBuvid;
    try {
      const resp = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (resp.ok) {
        const json = (await resp.json()) as { code?: number; data?: { b_3?: string; b_4?: string } };
        if (json.code === 0 && json.data?.b_3) {
          this.cachedBuvid = { b3: json.data.b_3, b4: json.data.b_4 ?? '' };
          return this.cachedBuvid;
        }
      }
      logger.warn(`[BilibiliLive] buvid fetch non-OK (HTTP ${resp.status}); proceeding without`);
    } catch (err) {
      logger.warn('[BilibiliLive] buvid fetch failed (proceeding without):', err);
    }
    this.cachedBuvid = { b3: '', b4: '' };
    return this.cachedBuvid;
  }

  // ── Send (receive-only clients can ignore) ──────────────────────

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
