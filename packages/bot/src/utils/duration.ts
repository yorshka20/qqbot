import { ConfigError } from '@/utils/errors';

/**
 * Parse a duration string to milliseconds: "30s", "5m", "1h", "250ms", or a
 * bare number of milliseconds. Anything else is a config error — guessing a
 * value for a timeout turns a typo into tasks being killed or never reaped.
 */
export function parseDuration(raw: string): number {
  const match = raw.trim().match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) {
    throw new ConfigError(`Invalid duration "${raw}" — expected e.g. "30s", "15m", "2h" or milliseconds`);
  }
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      return value;
  }
}
