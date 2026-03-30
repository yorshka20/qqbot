/**
 * Unified date/time formatting utilities with Asia/Shanghai timezone support.
 */

const TIMEZONE = 'Asia/Shanghai';

const WEEKDAY_MAP: Record<string, string> = {
  Sunday: '星期日',
  Monday: '星期一',
  Tuesday: '星期二',
  Wednesday: '星期三',
  Thursday: '星期四',
  Friday: '星期五',
  Saturday: '星期六',
};

/**
 * Format a date to YYYY-MM-DD HH:mm:ss with weekday in Asia/Shanghai timezone.
 * Example output: "2026-03-18 15:30:45 星期三"
 */
export function formatDateTimeFull(date: Date = new Date()): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  };

  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  const weekdayEn = get('weekday');
  const weekday = WEEKDAY_MAP[weekdayEn] ?? weekdayEn;

  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${weekday}`;
}

/**
 * Get the current date/time formatted for prompt injection.
 * Returns: "2026-03-18 15:30:45 星期三"
 */
export function getCurrentDateTimeForPrompt(): string {
  return formatDateTimeFull(new Date());
}

/**
 * Format a date to YYYY-MM-DD HH:mm in Asia/Shanghai timezone.
 * Suitable for RAG context and conversation history display.
 * Example output: "2026-03-18 15:30"
 */
export function formatDateTimeShort(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);

  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * Format a date to M/DD HH:mm in Asia/Shanghai timezone.
 * Compact format for inline display in conversation history.
 * Example output: "3/18 15:30"
 */
export function formatTimeCompact(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);

  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';

  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');

  return `${month}/${day} ${hour}:${minute}`;
}

/**
 * Format a date to HH:mm:ss in Asia/Shanghai timezone.
 * Time-only format for thread display.
 * Example output: "15:30:45"
 */
export function formatTimeOnly(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);

  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };

  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';

  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

/** The timezone used for all date formatting. */
export const DATE_TIMEZONE = TIMEZONE;

/**
 * Get the UTC offset string (e.g. "+09:00") for the configured timezone on a given date.
 * Handles DST-aware timezones correctly by checking the offset on the specific date.
 */
export function getTimezoneOffsetString(referenceDate: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(referenceDate);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value;
  const match = tz?.match(/GMT([+-]\d{2}:\d{2})/);
  if (match) return match[1];
  // "GMT" without offset means UTC
  return '+00:00';
}

/**
 * Create a Date object representing a specific local time in the configured timezone.
 * For example, dateInTimezone("2026-03-26", "00:00:00") returns a Date representing
 * 2026-03-26 00:00:00 in DATE_TIMEZONE, regardless of the machine's local timezone.
 */
export function dateInTimezone(dateStr: string, timeStr: string): Date {
  const refDate = new Date(`${dateStr}T12:00:00Z`);
  const offset = getTimezoneOffsetString(refDate);
  return new Date(`${dateStr}T${timeStr}${offset}`);
}
