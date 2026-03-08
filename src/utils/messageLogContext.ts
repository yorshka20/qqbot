// Shared helpers for per-message log tagging and coloring (used from EventRouter entry and MessagePipeline).

/** ANSI foreground colors for per-message log tags (distinct so concurrent messages are easy to tell apart). */
const LOG_TAG_COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m'] as const; // cyan, green, yellow, blue, magenta

/** Pick a stable color from key (e.g. messageId) for consistent per-message coloring. */
export function getLogColorForKey(key: string): string {
  let n = 0;
  for (let i = 0; i < key.length; i++) {
    n = (n * 31 + key.charCodeAt(i)) >>> 0;
  }
  return LOG_TAG_COLORS[n % LOG_TAG_COLORS.length];
}

/** Short tag for logs (last 6 chars of messageId or full id if shorter). */
export function getLogTag(messageId: string): string {
  const suffix = messageId.length >= 6 ? messageId.slice(-6) : messageId;
  return `msg:${suffix}`;
}
