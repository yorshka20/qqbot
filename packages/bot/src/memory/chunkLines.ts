/** Split text into chunks of whole lines, each at most `maxLength` characters (a longer single line stays whole). */
export function chunkLines(text: string, maxLength: number): string[] {
  if (!text.trim()) {
    return [];
  }
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const line of text.split('\n')) {
    const lineLen = line.length + 1;
    if (currentLen + lineLen > maxLength && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }
  return chunks;
}
