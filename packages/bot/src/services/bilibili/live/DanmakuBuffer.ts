// DanmakuBuffer — aggregates raw DanmakuEvents over a short window before
// dispatching them to the Live2DPipeline, so the avatar doesn't try to
// respond to every single danmaku.
//
// Design:
//   - Fixed interval tick (default 3000ms). No signal = no tick work.
//     (We still set the timer unconditionally; it just sees an empty buffer
//     and skips — that keeps the cadence predictable.)
//   - Dedup on normalized text: identical text from multiple viewers within
//     the window collapses into one entry with `count` + `senders` set.
//   - Mentions: matches the configured `streamerAliases` keyword list against
//     raw text (case-insensitive, substring). B-station danmaku is plain
//     text — there is no structured @ segment, so keyword matching is the
//     only available signal.
//
// The buffer does NOT store to DB and does NOT call the pipeline directly.
// Both concerns are owned by the Bridge, which subscribes to `flush` events.

import { EventEmitter } from 'node:events';
import { randomUUID } from '@/utils/randomUUID';
import { logger } from '@/utils/logger';
import type { DanmakuEvent } from './BilibiliLiveClient';

export interface DanmakuBufferOptions {
  /** Flush cadence in ms (default 3000). */
  flushIntervalMs?: number;
  /** Longest text accepted into the buffer; longer is truncated. Default 500. */
  maxTextLen?: number;
  /** Skip entries whose normalized text is empty. Default true. */
  skipEmpty?: boolean;
  /** Case-insensitive keywords matched against raw text for mention detection. */
  streamerAliases?: string[];
}

export interface BufferEntry {
  /** Normalized (trim + lowercased) text; used as dedup key. */
  normalizedText: string;
  /** The original (first seen) raw text for display. */
  rawText: string;
  /** Count of occurrences within this window. */
  count: number;
  /** Distinct sender uids seen this window. */
  senders: Set<string>;
  /** The last display name we saw for this text (so aggregation shows a human name). */
  lastUsername: string;
  /** True if any occurrence of this entry contained a streamer alias keyword. */
  mentionsStreamer: boolean;
  /** All raw DanmakuEvents collapsed into this entry — the store persists them individually. */
  rawEvents: DanmakuEvent[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface FlushPayload {
  batchId: string;
  /** Deduped entries, one per unique normalized text. */
  entries: BufferEntry[];
  /** Formatted prompt-ready summary text (for Live2DPipeline). */
  summaryText: string;
  /** Total raw event count collapsed into this flush (sum of counts). */
  totalDanmaku: number;
  /** Distinct sender count. */
  distinctSenders: number;
  /** Whether any entry mentioned the streamer. */
  anyMention: boolean;
  flushedAt: number;
}

export interface DanmakuBufferEvents {
  flush: (payload: FlushPayload) => void;
}

export declare interface DanmakuBuffer {
  on<K extends keyof DanmakuBufferEvents>(event: K, listener: DanmakuBufferEvents[K]): this;
  emit<K extends keyof DanmakuBufferEvents>(event: K, ...args: Parameters<DanmakuBufferEvents[K]>): boolean;
  off<K extends keyof DanmakuBufferEvents>(event: K, listener: DanmakuBufferEvents[K]): this;
}

const DEFAULT_FLUSH_MS = 3000;
const DEFAULT_MAX_TEXT_LEN = 500;

/**
 * Normalize a raw danmaku string for deduplication: trim + collapse internal
 * whitespace + lowercase. Returns '' if the result is empty.
 */
export function normalizeText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Detect whether `raw` contains any of the streamer aliases as a substring
 * (case-insensitive). Empty alias list → always false.
 */
export function detectMention(raw: string, aliases: string[] | undefined): boolean {
  if (!aliases || aliases.length === 0) return false;
  const hay = raw.toLowerCase();
  for (const alias of aliases) {
    const needle = alias.trim().toLowerCase();
    if (needle.length > 0 && hay.includes(needle)) return true;
  }
  return false;
}

/**
 * Format a buffer flush as a batch summary for the Live2DPipeline prompt.
 * Shape:
 *
 *   [直播间弹幕 · 过去3秒 · 8条 · 5人]
 *   - 米哈游工作室: 主播开播啦
 *   - 路人A x3: 666
 *   - 你好Ava（@你）: 看这里
 */
export function formatSummary(payload: Pick<FlushPayload, 'entries' | 'totalDanmaku' | 'distinctSenders' | 'flushedAt'>, windowMs: number): string {
  const windowSec = Math.round(windowMs / 1000);
  const header = `[直播间弹幕 · 过去${windowSec}秒 · ${payload.totalDanmaku}条 · ${payload.distinctSenders}人]`;
  const lines = payload.entries.map((e) => {
    const countTag = e.count > 1 ? ` x${e.count}` : '';
    const mentionTag = e.mentionsStreamer ? '（@你）' : '';
    return `- ${e.lastUsername}${countTag}${mentionTag}: ${e.rawText}`;
  });
  return [header, ...lines].join('\n');
}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: EventEmitter typed-event pattern
export class DanmakuBuffer extends EventEmitter {
  private readonly flushIntervalMs: number;
  private readonly maxTextLen: number;
  private readonly skipEmpty: boolean;
  private readonly streamerAliases: string[];
  private entries = new Map<string, BufferEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DanmakuBufferOptions = {}) {
    super();
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.maxTextLen = options.maxTextLen ?? DEFAULT_MAX_TEXT_LEN;
    this.skipEmpty = options.skipEmpty !== false;
    this.streamerAliases = options.streamerAliases ?? [];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.flushIntervalMs);
    logger.info(
      `[DanmakuBuffer] started, flushInterval=${this.flushIntervalMs}ms aliases=${JSON.stringify(this.streamerAliases)}`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.entries.clear();
  }

  /**
   * Accept one raw danmaku into the buffer. Truncates overlong text, skips
   * empty-after-normalize unless configured otherwise, and merges into the
   * existing entry keyed by normalized text.
   */
  push(evt: DanmakuEvent): void {
    const raw = evt.text.length > this.maxTextLen ? evt.text.slice(0, this.maxTextLen) : evt.text;
    const normalized = normalizeText(raw);
    if (this.skipEmpty && normalized.length === 0) return;

    const mention = detectMention(raw, this.streamerAliases);
    const now = Date.now();
    const existing = this.entries.get(normalized);
    if (existing) {
      existing.count += 1;
      existing.senders.add(evt.uid);
      existing.lastUsername = evt.username || existing.lastUsername;
      existing.mentionsStreamer = existing.mentionsStreamer || mention;
      existing.rawEvents.push(evt);
      existing.lastSeenAt = now;
    } else {
      this.entries.set(normalized, {
        normalizedText: normalized,
        rawText: raw,
        count: 1,
        senders: new Set([evt.uid]),
        lastUsername: evt.username,
        mentionsStreamer: mention,
        rawEvents: [evt],
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }

  /** For tests / manual triggers — skips the timer. */
  flushNow(): FlushPayload | null {
    return this.tick();
  }

  private tick(): FlushPayload | null {
    if (this.entries.size === 0) return null;

    const entries = [...this.entries.values()].sort((a, b) => b.count - a.count);
    this.entries.clear();

    const totalDanmaku = entries.reduce((n, e) => n + e.count, 0);
    const distinctSenders = new Set<string>();
    for (const e of entries) for (const uid of e.senders) distinctSenders.add(uid);
    const anyMention = entries.some((e) => e.mentionsStreamer);

    const batchId = randomUUID();
    const flushedAt = Date.now();
    const summaryText = formatSummary(
      { entries, totalDanmaku, distinctSenders: distinctSenders.size, flushedAt },
      this.flushIntervalMs,
    );
    const payload: FlushPayload = {
      batchId,
      entries,
      summaryText,
      totalDanmaku,
      distinctSenders: distinctSenders.size,
      anyMention,
      flushedAt,
    };
    this.emit('flush', payload);
    return payload;
  }
}
