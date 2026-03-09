/**
 * Segment data helpers for message segments (e.g. image, file, market_face).
 * Supports both camelCase and snake_case keys from protocol normalizers.
 */

/**
 * Get a value from segment data supporting both camelCase and snake_case keys.
 * Tries each key in order and returns the first string value found.
 */
export function getDataValue(data: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'string' && v) {
      return v;
    }
  }
  return undefined;
}
