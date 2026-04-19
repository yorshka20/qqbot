// BilibiliLiveBridge — wires BilibiliLiveClient → DanmakuBuffer → (DanmakuStore
// + Live2DPipeline). This is the single place that knows about all four and
// chooses when to persist / dispatch vs. drop.
//
// Flow per incoming danmaku:
//   1. LiveClient emits 'danmaku' — bridge pushes into the buffer (which
//      runs its own normalize/dedup logic).
//   2. Buffer emits 'flush' on its 3s tick when non-empty — bridge:
//        a. writes every raw event from the flush into DanmakuStore
//           (preserving per-sender history, even for deduped entries)
//        b. if pipeToLive2D, hands the formatted summaryText off to the
//           Live2DPipeline for the avatar reaction
//
// Lifecycle: `start()` connects the live client; `stop()` tears it down.
// Re-entrant: calling `start()` while already started is a no-op; calling
// after `stop()` connects fresh. The `/live2d` command uses this to let
// the operator connect on demand (e.g. only after going live).
//
// Observability: the bridge attaches `error`/`open`/`close` listeners on
// the client not to react but so the client's EventEmitter stays "error-
// listened" — without an error listener, Node rethrows `emit('error')`
// synchronously, which would escape our start()'s try/catch.

import type { Live2DPipeline } from '@/services/live2d/Live2DPipeline';
import { logger } from '@/utils/logger';
import type { BilibiliLiveClient, DanmakuEvent } from './BilibiliLiveClient';
import type { DanmakuBuffer, FlushPayload } from './DanmakuBuffer';
import { detectMention } from './DanmakuBuffer';
import type { DanmakuStore } from './DanmakuStore';

export interface BilibiliLiveBridgeOptions {
  roomId: string;
  pipeToLive2D: boolean;
  streamerAliases: string[];
}

export interface BridgeStatus {
  started: boolean;
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  /** True when the client gave up after the configured retry cap. */
  exhausted: boolean;
  roomId: string;
  pipeToLive2D: boolean;
  streamerAliases: string[];
}

export class BilibiliLiveBridge {
  private started = false;
  private lastError: string | null = null;
  private onDanmaku = this.handleDanmaku.bind(this);
  private onFlush = this.handleFlush.bind(this);
  private onClientError = (err: Error): void => {
    this.lastError = err.message;
  };
  private onClientOpen = (): void => {
    this.lastError = null;
    logger.info(`[BilibiliLiveBridge] client open (room=${this.opts.roomId})`);
  };
  private onClientClose = (reason: string): void => {
    logger.info(`[BilibiliLiveBridge] client closed: ${reason}`);
  };

  constructor(
    private readonly client: BilibiliLiveClient,
    private readonly buffer: DanmakuBuffer,
    private readonly store: DanmakuStore,
    private readonly pipeline: Live2DPipeline,
    private readonly opts: BilibiliLiveBridgeOptions,
  ) {}

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Current aggregate status of the bridge + underlying client. Intended for
   * the `/live2d status` command; keep flat + primitive-valued.
   */
  getStatus(): BridgeStatus & { lastError: string | null } {
    return {
      started: this.started,
      connected: this.client.isConnected(),
      reconnecting: this.client.isReconnecting(),
      reconnectAttempts: this.client.getReconnectAttempts(),
      exhausted: this.client.isExhausted(),
      roomId: this.opts.roomId,
      pipeToLive2D: this.opts.pipeToLive2D,
      streamerAliases: this.opts.streamerAliases,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.lastError = null;
    this.client.on('danmaku', this.onDanmaku);
    this.client.on('error', this.onClientError);
    this.client.on('open', this.onClientOpen);
    this.client.on('close', this.onClientClose);
    this.buffer.on('flush', this.onFlush);
    this.buffer.start();
    // `client.start()` internally schedules reconnects on failure — it does
    // not throw on -352 etc., so we don't need a try/catch here.
    await this.client.start();
    logger.info(`[BilibiliLiveBridge] started (room=${this.opts.roomId}, pipeToLive2D=${this.opts.pipeToLive2D})`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.client.off('danmaku', this.onDanmaku);
    this.client.off('error', this.onClientError);
    this.client.off('open', this.onClientOpen);
    this.client.off('close', this.onClientClose);
    this.buffer.off('flush', this.onFlush);
    this.buffer.stop();
    await this.client.stop();
    await this.store.flush().catch(() => {});
    logger.info('[BilibiliLiveBridge] stopped');
  }

  /**
   * Convenience for `/live2d reconnect`: stop, then start, preserving the
   * same bridge instance (and therefore the same DI registration).
   */
  async reconnect(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private handleDanmaku(evt: DanmakuEvent): void {
    this.buffer.push(evt);
  }

  private async handleFlush(payload: FlushPayload): Promise<void> {
    // Persist every raw event — dedup is a display concern, not a storage
    // one. Tagging each row with `batchId` + per-event mention status lets
    // RAG later reconstruct "what did the avatar see" windows.
    for (const entry of payload.entries) {
      const entryMention = entry.mentionsStreamer;
      for (const raw of entry.rawEvents) {
        // Per-row mention flag: if the entry collapsed multiple raws, at
        // least one contained an alias keyword. Re-check the individual raw
        // so rows that *didn't* contain it aren't false-positive-tagged.
        const thisMention = entryMention && detectMention(raw.text, this.opts.streamerAliases);
        this.store.enqueue(raw, {
          roomId: this.opts.roomId,
          batchId: payload.batchId,
          mentionsStreamer: thisMention,
        });
      }
    }

    if (!this.opts.pipeToLive2D) return;

    try {
      const result = await this.pipeline.enqueue({
        text: payload.summaryText,
        source: 'bilibili-danmaku-batch',
        meta: {
          batchId: payload.batchId,
          totalDanmaku: payload.totalDanmaku,
          distinctSenders: payload.distinctSenders,
          anyMention: payload.anyMention,
        },
      });
      if (result.skipped) {
        logger.debug(
          `[BilibiliLiveBridge] flush batchId=${payload.batchId} skipped by pipeline (${result.skipReason}); total=${payload.totalDanmaku}`,
        );
      } else {
        logger.debug(
          `[BilibiliLiveBridge] flush batchId=${payload.batchId} → ${result.tagCount} tags; total=${payload.totalDanmaku}`,
        );
      }
    } catch (err) {
      logger.warn('[BilibiliLiveBridge] pipeline dispatch failed:', err);
    }
  }
}
