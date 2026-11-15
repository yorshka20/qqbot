// Per-message log tags. The console colours a tag from its text (`LogLineRenderer` in @qqbot/shared).

/** Short tag for logs (last 6 chars of messageId or full id if shorter). */
export function getLogTag(messageId: string): string {
  const suffix = messageId.length >= 6 ? messageId.slice(-6) : messageId;
  return `msg:${suffix}`;
}
