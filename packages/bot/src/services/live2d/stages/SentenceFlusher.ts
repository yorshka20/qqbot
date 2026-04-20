// SentenceFlusher — buffer streaming LLM output and flush on sentence-sized
// boundaries so downstream TTS can start synthesizing early instead of waiting
// for the entire reply.
//
// Flush rules (in priority order):
//   1. Sentence terminator (`。！？.!?`) → flush up to and including terminator.
//   2. Buffer length >= `minCharsForSeparator` AND a clause separator
//      (`，,；;、—`) exists in the buffer → flush up to and including the
//      LATEST separator. "At least 20 chars before cutting" (configurable).
//   3. Never hard-cut mid-word or mid-char-run when no separator exists.
//   4. Never flush while a Live2D tag is open (`[` without matching `]`).
//      Tags that straddle a flush boundary would be written as partial text
//      into the spoken stream — we wait until the tag closes.
//
// `end()` flushes any remaining buffer verbatim (end-of-stream).

const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '.', '!', '?']);
const CLAUSE_SEPARATORS = new Set(['，', ',', '；', ';', '、', '—']);
const DEFAULT_MIN_CHARS_FOR_SEPARATOR = 20;

export interface SentenceFlusherOptions {
  /** Only flush on a clause separator once the buffer reaches this length. */
  minCharsForSeparator?: number;
}

export class SentenceFlusher {
  private buffer = '';
  private readonly minCharsForSeparator: number;

  constructor(
    private readonly onFlush: (text: string) => void,
    opts: SentenceFlusherOptions = {},
  ) {
    this.minCharsForSeparator = opts.minCharsForSeparator ?? DEFAULT_MIN_CHARS_FOR_SEPARATOR;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    // Drain as many complete sentences as the current buffer allows — a single
    // large chunk may contain multiple sentences.
    while (this.tryFlushOnce()) {
      /* noop — tryFlushOnce already emitted */
    }
  }

  end(): void {
    const trimmed = this.buffer.trim();
    if (trimmed.length > 0) {
      this.onFlush(this.buffer);
    }
    this.buffer = '';
  }

  private tryFlushOnce(): boolean {
    if (this.buffer.length === 0) return false;

    // Clamp flush region to anything BEFORE an unclosed `[LIVE2D:` tag.
    // Content beyond that point belongs to a tag that's still streaming in;
    // flushing through it would leak partial tag text into the spoken stream.
    const cutoff = this.findSafeCutoff();
    if (cutoff === 0) return false;
    const safe = this.buffer.slice(0, cutoff);

    const termIdx = this.findFirstTerminator(safe);
    if (termIdx !== -1) {
      this.emit(termIdx + 1);
      return true;
    }

    if (safe.length >= this.minCharsForSeparator) {
      const sepIdx = this.findLastSeparator(safe);
      if (sepIdx !== -1) {
        this.emit(sepIdx + 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Returns the index of the first `[` whose matching `]` hasn't arrived yet
   * — i.e. the start of a still-streaming tag. Returns buffer length when no
   * tag is open. Only the content before this index is safe to flush.
   */
  private findSafeCutoff(): number {
    let i = 0;
    while (i < this.buffer.length) {
      const open = this.buffer.indexOf('[', i);
      if (open === -1) return this.buffer.length;
      const close = this.buffer.indexOf(']', open);
      if (close === -1) return open;
      i = close + 1;
    }
    return this.buffer.length;
  }

  /**
   * Find the first sentence terminator, SKIPPING any that appear inside a
   * `[LIVE2D: ...]` tag (e.g. `intensity=0.8` has a `.` that must not be
   * treated as end-of-sentence). Assumes any `[` in `s` has a matching `]`
   * — the caller (`tryFlushOnce`) enforces that by slicing to the safe cutoff.
   */
  private findFirstTerminator(s: string): number {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '[') {
        const close = s.indexOf(']', i);
        if (close === -1) return -1;
        i = close + 1;
        continue;
      }
      if (SENTENCE_TERMINATORS.has(ch)) return i;
      i++;
    }
    return -1;
  }

  /**
   * Find the last clause separator outside any tag region. Same rationale
   * as `findFirstTerminator` — `,` / `，` inside tags must not be cut points.
   */
  private findLastSeparator(s: string): number {
    // Walk forward, remembering the latest separator seen outside a tag.
    let lastSep = -1;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '[') {
        const close = s.indexOf(']', i);
        if (close === -1) return lastSep;
        i = close + 1;
        continue;
      }
      if (CLAUSE_SEPARATORS.has(ch)) lastSep = i;
      i++;
    }
    return lastSep;
  }

  private emit(upToIdx: number): void {
    const chunk = this.buffer.slice(0, upToIdx);
    this.buffer = this.buffer.slice(upToIdx);
    if (chunk.trim().length > 0) this.onFlush(chunk);
  }
}
