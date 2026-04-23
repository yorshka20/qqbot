// SentenceFlusher — buffer streaming LLM output and flush on sentence-sized
// boundaries so downstream TTS can start synthesizing early instead of waiting
// for the entire reply.
//
// Flush rules (in priority order):
//   1. Sentence terminator (`。！？.!?`) → flush up to and including terminator,
//      greedily extending through any consecutive trailing terminators/clause
//      separators so "你好。。" stays together as one chunk instead of
//      splintering into an orphan "。" that would crash TTS.
//   2. Buffer length >= `minCharsForSeparator` AND a clause separator
//      (`，,；;、—`) exists in the buffer → flush up to and including the
//      LATEST separator. "At least 20 chars before cutting" (configurable).
//   3. Pure-punctuation candidates (e.g. "。。。" for silence) are DROPPED
//      rather than emitted — they would otherwise be sent to TTS which errors
//      on whitespace/punctuation-only input.
//   4. Never hard-cut mid-word or mid-char-run when no separator exists.
//   5. Never flush while a Live2D tag is open (`[` without matching `]`).
//      Tags that straddle a flush boundary would be written as partial text
//      into the spoken stream — we wait until the tag closes.
//
// `end()` flushes any remaining buffer verbatim (end-of-stream), subject to
// the same pure-punctuation drop rule.

const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '.', '!', '?']);
const CLAUSE_SEPARATORS = new Set(['，', ',', '；', ';', '、', '—']);
const DEFAULT_MIN_CHARS_FOR_SEPARATOR = 20;
/**
 * Minimum chars before the FIRST flush is allowed to cut at a clause separator.
 * Kept much lower than `minCharsForSeparator` so downstream TTS can start
 * synthesizing as soon as the model has produced a usable phrase — this is
 * the single biggest lever on first-utterance latency.
 */
const DEFAULT_FIRST_FLUSH_MIN_CHARS = 8;

/**
 * A chunk is "speakable" if it contains at least one character that isn't
 * whitespace, a sentence terminator, or a clause separator. Pure-punctuation
 * chunks (most commonly "。。。" indicating silence) must not reach TTS —
 * providers like GPT-SoVITS error on empty/punctuation-only input.
 */
function hasSpeakableContent(s: string): boolean {
  for (const ch of s) {
    if (SENTENCE_TERMINATORS.has(ch)) continue;
    if (CLAUSE_SEPARATORS.has(ch)) continue;
    if (/\s/.test(ch)) continue;
    return true;
  }
  return false;
}

export interface SentenceFlusherOptions {
  /** Only flush on a clause separator once the buffer reaches this length. */
  minCharsForSeparator?: number;
  /**
   * Threshold used ONLY until the first flush happens. After that the flusher
   * switches to `minCharsForSeparator`. Set equal to `minCharsForSeparator`
   * if you want uniform behavior.
   */
  firstFlushMinChars?: number;
}

export class SentenceFlusher {
  private buffer = '';
  private readonly minCharsForSeparator: number;
  private readonly firstFlushMinChars: number;
  private firstFlushDone = false;

  constructor(
    private readonly onFlush: (text: string) => void,
    opts: SentenceFlusherOptions = {},
  ) {
    this.minCharsForSeparator = opts.minCharsForSeparator ?? DEFAULT_MIN_CHARS_FOR_SEPARATOR;
    this.firstFlushMinChars = opts.firstFlushMinChars ?? DEFAULT_FIRST_FLUSH_MIN_CHARS;
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
    // Drop pure-punctuation/whitespace tails (e.g. the stream ended on "。。。"
    // with nothing speakable) — TTS would reject them anyway.
    if (this.buffer.trim().length > 0 && hasSpeakableContent(this.buffer)) {
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
      // Greedy-extend through consecutive terminators/clause separators so
      // trailing punctuation sticks with the sentence it belongs to ("你好。。"
      // emits as one chunk, not "你好。" followed by an orphan "。").
      let end = termIdx + 1;
      while (end < safe.length) {
        const ch = safe[end];
        if (ch !== undefined && (SENTENCE_TERMINATORS.has(ch) || CLAUSE_SEPARATORS.has(ch))) {
          end++;
          continue;
        }
        break;
      }
      return this.flushCandidate(end);
    }

    const separatorThreshold = this.firstFlushDone ? this.minCharsForSeparator : this.firstFlushMinChars;
    if (safe.length >= separatorThreshold) {
      const sepIdx = this.findLastSeparator(safe);
      if (sepIdx !== -1) {
        return this.flushCandidate(sepIdx + 1);
      }
    }
    return false;
  }

  /**
   * Emit `buffer[0..end]` as a chunk, OR — if that slice has no speakable
   * content (e.g. "。。。") — silently drop it from the buffer and signal
   * the caller to keep draining. This collapses silence-style punctuation-
   * only output into a no-op instead of flooding TTS with unusable chunks.
   */
  private flushCandidate(end: number): boolean {
    const candidate = this.buffer.slice(0, end);
    if (!hasSpeakableContent(candidate)) {
      this.buffer = this.buffer.slice(end);
      return this.buffer.length > 0;
    }
    this.emit(end);
    return true;
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
    if (chunk.trim().length > 0) {
      this.firstFlushDone = true;
      this.onFlush(chunk);
    }
  }
}
