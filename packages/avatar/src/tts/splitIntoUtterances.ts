/**
 * Split AI reply text into playback-sized utterances.
 *
 * 1. Primary split on sentence terminators (Chinese: 。！？ / English: . ! ?)
 *    keeping the terminator attached to the preceding chunk
 * 2. If any resulting chunk > maxChars, secondary-split on clause separators
 *    (, ， ; ； 、 —) preferring the one closest to the chunk midpoint
 * 3. Trim each chunk, drop empty/whitespace-only
 */
export function splitIntoUtterances(text: string, maxChars = 80): string[] {
  const sentenceTerminatorChars = '。！？.!?';
  const clauseSeparatorChars = '，,；;、—';

  // Step 1: split by sentence terminators
  const sentences: string[] = [];
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;

    // Check if this char is a sentence terminator
    if (sentenceTerminatorChars.includes(char)) {
      sentences.push(current);
      current = '';
    }
  }

  // Add any remaining text as the last sentence (if no terminator at end)
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
        if (clauseSeparatorChars.includes(trimmed[i])) {
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

  return result.filter((s) => s.trim().length > 0);
}
