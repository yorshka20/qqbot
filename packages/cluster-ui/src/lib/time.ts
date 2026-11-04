const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function toMs(iso: string | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** "7 分钟", "2 小时 5 分", "3 天": a span read at a glance, never finer than a minute. */
export function formatSpan(ms: number): string {
  if (ms < MINUTE) {
    return '不到 1 分钟';
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)} 分钟`;
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }
  return `${Math.floor(ms / DAY)} 天`;
}

/** A wait, as the inbox says it. */
export function formatWait(ms: number): string {
  return ms < MINUTE ? '刚刚' : `等了 ${formatSpan(ms)}`;
}

/** How long ago something ended. */
export function formatAgo(ms: number): string {
  return ms < MINUTE ? '刚刚' : `${formatSpan(ms)}前`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `15:02` today, `11-03 15:02` on any other day. */
export function formatClock(ms: number, now: number): string {
  const at = new Date(ms);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === new Date(now).toDateString()
    ? clock
    : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}
