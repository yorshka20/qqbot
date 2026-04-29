// BilibiliLiveBridge — wires BilibiliLiveClient → DanmakuBuffer → (DanmakuStore
// + MessagePipeline). This is the single place that knows about all four and
// chooses when to persist / dispatch vs. drop.
//
// Flow per incoming danmaku:
//   1. LiveClient emits 'danmaku' — bridge pushes into the buffer (which
//      runs its own normalize/dedup logic).
//   2. Buffer emits 'flush' on its 3s tick when non-empty — bridge:
//        a. writes every raw event from the flush into DanmakuStore
//           (preserving per-sender history, even for deduped entries)
//        b. if pipeToLive2D, constructs a synthetic NormalizedMessageEvent
//           (source=bilibili-danmaku) and dispatches via MessagePipeline.
//           SourceConfig discards the reply; serial=true enforces single-flight.
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

import type { MessagePipeline } from '@/conversation/MessagePipeline';
import type { MessageProcessingContext } from '@/conversation/types';
import { makeSyntheticEvent } from '@/conversation/synthetic';
import type { AvatarBatchSender } from '@/integrations/avatar/types';
import { logger } from '@/utils/logger';
import type { BilibiliLiveClient, DanmakuEvent } from './BilibiliLiveClient';
import type { BufferEntry, DanmakuBuffer, FlushPayload } from './DanmakuBuffer';
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
    private readonly messagePipeline: MessagePipeline,
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

    // TODO([4/5]→follow-up): batchId/totalDanmaku/distinctSenders/anyMention/senders
    // used to flow via Live2DInput.meta. If downstream prompt scenes need this
    // metadata, thread it through MessageProcessingContext extension.
    const event = makeSyntheticEvent({
      source: 'bilibili-danmaku',
      userId: '__bilibili__',
      groupId: `bili-room-${this.opts.roomId}`,
      text: payload.summaryText,
      messageType: 'group',
      protocol: 'milky',
    });
    const procContext: MessageProcessingContext = {
      message: event,
      sessionId: `bili-room-${this.opts.roomId}`,
      sessionType: 'group',
      botSelfId: '',
      source: 'bilibili-danmaku',
      // No responseCallback: SourceConfig.responseHandler === 'discard' drops the reply.
    };
    try {
      const result = await this.messagePipeline.process(event, procContext, 'bilibili-danmaku');
      logger.debug(
        `[BilibiliLiveBridge] flush batchId=${payload.batchId} processed (success=${result.success}); total=${payload.totalDanmaku}`,
      );
    } catch (err) {
      logger.warn('[BilibiliLiveBridge] pipeline dispatch failed:', err);
    }
  }
}

/**
 * Collapse a flush payload's entries into one {@link AvatarBatchSender} per
 * distinct uid. A single uid may appear across multiple `BufferEntry`s (if
 * they said different things), so we fold by uid and join their raw lines
 * with `\n` — that joined text becomes the per-user RAG query downstream.
 *
 * `name` takes the most-recent `lastUsername` seen for the uid (later
 * entries overwrite earlier ones; acceptable because a user's display name
 * rarely changes mid-3s-window, and the last one we saw is freshest).
 *
 * Exported for unit testing. Kept close to the bridge (not in DanmakuBuffer)
 * because the buffer doesn't know about live2d / per-user memory — this is
 * a pure integration-layer concern.
 */
export function aggregateBatchSenders(entries: BufferEntry[]): AvatarBatchSender[] {
  // Insertion-order Map guarantees stable output for tests + cache stability.
  const byUid = new Map<string, { name: string; texts: string[] }>();
  for (const entry of entries) {
    for (const uid of entry.senders) {
      if (!uid) continue;
      const existing = byUid.get(uid);
      if (existing) {
        existing.texts.push(entry.rawText);
        if (entry.lastUsername) existing.name = entry.lastUsername;
      } else {
        byUid.set(uid, {
          name: entry.lastUsername ?? '',
          texts: [entry.rawText],
        });
      }
    }
  }
  const out: AvatarBatchSender[] = [];
  for (const [uid, agg] of byUid) {
    out.push({ uid, name: agg.name, text: agg.texts.join('\n') });
  }
  return out;
}
