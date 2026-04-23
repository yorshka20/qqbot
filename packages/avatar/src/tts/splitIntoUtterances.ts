const SENTENCE_TERMINATOR_CHARS = '。！？.!?';
const CLAUSE_SEPARATOR_CHARS = '，,；;、—';

/**
 * A string is "speakable" when it has at least one character that isn't a
 * sentence terminator, clause separator, or whitespace. TTS providers like
 * GPT-SoVITS reject empty/punctuation-only input outright, so chunks that
 * fail this check MUST NOT reach `provider.synthesize()`.
 */
function hasSpeakableContent(s: string): boolean {
  for (const ch of s) {
    if (SENTENCE_TERMINATOR_CHARS.includes(ch)) continue;
    if (CLAUSE_SEPARATOR_CHARS.includes(ch)) continue;
    if (/\s/.test(ch)) continue;
    return true;
  }
  return false;
}

/**
 * Split AI reply text into playback-sized utterances.
 *
 * 1. Primary split on sentence terminators (Chinese: 。！？ / English: . ! ?)
 *    keeping the terminator attached to the preceding chunk. Consecutive
 *    trailing terminators/clause separators are GREEDY-EXTENDED into the
 *    same chunk so "主人？！" stays one utterance — otherwise the lone "！"
 *    would go to TTS as a punctuation-only chunk and crash synthesis.
 * 2. If any resulting chunk > maxChars, secondary-split on clause separators
 *    (, ， ; ； 、 —) preferring the one closest to the chunk midpoint
 * 3. Drop chunks with no speakable content (empty, whitespace-only, or
 *    punctuation-only like "。。。" for modelled silence).
 */
export function splitIntoUtterances(text: string, maxChars = 80): string[] {
  // Step 1: split by sentence terminators, greedy-extending through any
  // immediately-following terminators/clause separators.
  const sentences: string[] = [];
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;

    if (SENTENCE_TERMINATOR_CHARS.includes(char)) {
      while (
        i + 1 < text.length &&
        (SENTENCE_TERMINATOR_CHARS.includes(text[i + 1]) || CLAUSE_SEPARATOR_CHARS.includes(text[i + 1]))
      ) {
        i++;
        current += text[i];
      }
      sentences.push(current);
      current = '';
    }
  }

  if (current.trim().length > 0) {
    sentences.push(current);
  }

  // Step 2 & 3: process each sentence, splitting if too long
  const result: string[] = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    if (sentence.length <= maxChars) {
      result.push(sentence);
    } else {
      // Secondary split on clause separators
      // Note: we work with 'trimmed' for finding separators since leading
      // whitespace doesn't affect separator positions
      const parts: string[] = [];
      const matches: number[] = [];

      for (let i = 0; i < trimmed.length; i++) {
        if (CLAUSE_SEPARATOR_CHARS.includes(trimmed[i])) {
          matches.push(i);
        }
      }

      if (matches.length === 0) {
        // No clause separators found, hard split by maxChars
        for (let i = 0; i < trimmed.length; i += maxChars) {
          const chunk = trimmed.slice(i, i + maxChars).trim();
          if (chunk.length > 0) parts.push(chunk);
        }
      } else {
        // Find the separator closest to midpoint
        const midpoint = trimmed.length / 2;
        let bestMatch = matches[0];
        let bestDistance = Math.abs(matches[0] - midpoint);

        for (const m of matches) {
          const distance = Math.abs(m - midpoint);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestMatch = m;
          }
        }

        // Split around the best match
        const firstPart = trimmed.slice(0, bestMatch + 1).trim();
        const secondPart = trimmed.slice(bestMatch + 1).trim();

        if (firstPart.length > 0) parts.push(firstPart);
        if (secondPart.length > 0) {
          // Recursively split the second part if still too long
          const subParts = splitIntoUtterances(secondPart, maxChars);
          parts.push(...subParts);
        }
      }

      result.push(...parts);
    }
  }

  // Final guard: drop anything whose non-punctuation/whitespace content is
  // empty. This is the last line of defense against punctuation-only chunks
  // (e.g. from models emitting "。。。" for silence) reaching TTS.
  return result.filter(hasSpeakableContent);
}
