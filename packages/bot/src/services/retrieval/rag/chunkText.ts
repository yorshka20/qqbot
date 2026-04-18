// Text chunking utility for RAG ingestion
// Splits text into overlapping chunks by paragraph boundaries for better semantic coherence.

export interface ChunkOptions {
  /** Target chunk size in characters (default 600) */
  chunkSize?: number;
  /** Overlap between consecutive chunks in characters (default 100) */
  overlap?: number;
  /** Minimum chunk size — chunks shorter than this are merged into the previous one (default 80) */
  minChunkSize?: number;
}

export interface TextChunk {
  /** Chunk text content */
  text: string;
  /** 0-based index of this chunk */
  index: number;
}

/**
 * Split text into overlapping chunks, preferring paragraph boundaries.
 *
 * Strategy:
 * 1. Split by double-newline (paragraph breaks) first.
 * 2. Greedily accumulate paragraphs until approaching `chunkSize`.
 * 3. When a paragraph would exceed the limit, emit the current chunk and start a new one
 *    with `overlap` characters carried over from the end of the previous chunk.
 * 4. If a single paragraph exceeds `chunkSize`, fall back to sentence splitting,
 *    then to hard character splitting.
 */
export function chunkText(text: string, options?: ChunkOptions): TextChunk[] {
  const chunkSize = options?.chunkSize ?? 600;
  const overlap = options?.overlap ?? 100;
  const minChunkSize = options?.minChunkSize ?? 80;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // If text is short enough, return as single chunk
  if (trimmed.length <= chunkSize) {
    return [{ text: trimmed, index: 0 }];
  }

  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: TextChunk[] = [];
  let currentParts: string[] = [];
  let currentLen = 0;

  const emitChunk = () => {
    if (currentParts.length === 0) return;
    const chunkContent = currentParts.join('\n\n').trim();
    if (chunkContent.length === 0) return;

    // If this chunk is too small and there's a previous chunk, merge it
    if (chunkContent.length < minChunkSize && chunks.length > 0) {
      const prev = chunks[chunks.length - 1]!;
      prev.text = `${prev.text}\n\n${chunkContent}`;
      return;
    }

    chunks.push({ text: chunkContent, index: chunks.length });
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (p.length === 0) continue;

    // If single paragraph exceeds chunkSize, split it further
    if (p.length > chunkSize) {
      // Emit what we have so far
      emitChunk();
      currentParts = [];
      currentLen = 0;

      // Split large paragraph by sentences or hard boundary
      const subChunks = splitLargeParagraph(p, chunkSize, overlap);
      for (const sub of subChunks) {
        chunks.push({ text: sub, index: chunks.length });
      }
      continue;
    }

    // Would adding this paragraph exceed the target?
    const addedLen = currentLen > 0 ? p.length + 2 : p.length; // +2 for '\n\n' separator
    if (currentLen + addedLen > chunkSize && currentParts.length > 0) {
      emitChunk();

      // Start new chunk with overlap from the tail of the previous chunk
      const prevText = currentParts.join('\n\n');
      const overlapText = prevText.length > overlap ? prevText.slice(-overlap) : prevText;
      currentParts = [overlapText, p];
      currentLen = overlapText.length + 2 + p.length;
    } else {
      currentParts.push(p);
      currentLen += addedLen;
    }
  }

  // Emit remaining
  emitChunk();

  return chunks;
}

/**
 * Split a single large paragraph into chunks, trying sentence boundaries first.
 */
function splitLargeParagraph(text: string, chunkSize: number, overlap: number): string[] {
  // Try splitting by Chinese/English sentence boundaries
  const sentences = text.split(/(?<=[。！？.!?\n])\s*/);
  if (sentences.length > 1) {
    return greedyMerge(sentences, chunkSize, overlap);
  }

  // Fallback: hard character split with overlap
  const results: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    results.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length - overlap) {
      // Last chunk — don't create a tiny tail
      break;
    }
  }
  return results;
}

/**
 * Greedily merge sentence segments into chunks of ~chunkSize with overlap.
 */
function greedyMerge(segments: string[], chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const seg of segments) {
    if (current.length + seg.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Carry overlap from end of current
      const overlapText = current.length > overlap ? current.slice(-overlap) : current;
      current = overlapText + seg;
    } else {
      current += seg;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}
