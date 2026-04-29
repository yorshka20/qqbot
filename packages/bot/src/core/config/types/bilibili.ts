// Bilibili-specific configuration.
//
// Only the `live` sub-block is consumed right now (danmaku listener + avatar
// bridge). The top-level namespace is reserved so future additions (e.g.
// dynamic feed subscriptions) fit cleanly.

export interface BilibiliLiveBufferConfig {
  /** Flush cadence in milliseconds. Default 3000. */
  flushIntervalMs?: number;
  /** Hard cap on individual danmaku length fed into the buffer. Default 500. */
  maxTextLen?: number;
}

export interface BilibiliLiveSendConfig {
  /** Master switch for sendDanmaku. Default false — the capability is opt-in. */
  enabled?: boolean;
}

export interface BilibiliLiveConfig {
  /**
   * Master switch. When false, the bridge is not constructed at all.
   * When true, the bridge exists but connection is gated on `autoConnect`.
   */
  enabled: boolean;
  /**
   * Auto-connect to the live room on bot start. Default `false` — connect
   * on demand via `/live2d connect` so the bot doesn't hammer bilibili
   * with retries while the room is offline or risk-controlled.
   */
  autoConnect?: boolean;
  /** Live room ID (the numeric one, not the short URL id). */
  roomId: number;
  /** Optional SESSDATA cookie for authenticated viewing and higher rate limits. */
  sessdata?: string;
  /** CSRF token (bili_jct cookie). Required only when `send.enabled=true`. */
  biliJct?: string;
  /** Forward each flush to drive the avatar pipeline. Default true. */
  pipeToLive2D?: boolean;
  /**
   * Keyword list used to detect @-style mentions of the streamer. B-station
   * danmaku is plain text with no structured @ segment — substring match
   * against the streamer's display names is the only available signal.
   */
  streamerAliases?: string[];
  /** Buffer timing / size knobs. */
  buffer?: BilibiliLiveBufferConfig;
  /** Danmaku send-back capability. Default disabled. */
  send?: BilibiliLiveSendConfig;
}

export interface BilibiliConfig {
  live?: BilibiliLiveConfig;
}
