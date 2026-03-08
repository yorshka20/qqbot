// Shared helpers for per-message log tagging and coloring (used from EventRouter entry and MessagePipeline).
// All coloring is BACKGROUND only (no text/foreground color).

/** ANSI background codes (40–47): cyan, green, yellow, blue, magenta. */
const LOG_BG_COLORS = ['\x1b[46m', '\x1b[42m', '\x1b[43m', '\x1b[44m', '\x1b[45m'] as const;

/** Pick a stable background color from key (e.g. messageId). Returns ANSI background code (e.g. \\x1b[46m). */
export function getLogColorForKey(key: string): string {
  let n = 0;
  for (let i = 0; i < key.length; i++) {
    n = (n * 31 + key.charCodeAt(i)) >>> 0;
  }
  return LOG_BG_COLORS[n % LOG_BG_COLORS.length];
}

/** Short tag for logs (last 6 chars of messageId or full id if shorter). */
export function getLogTag(messageId: string): string {
  const suffix = messageId.length >= 6 ? messageId.slice(-6) : messageId;
  return `msg:${suffix}`;
}
