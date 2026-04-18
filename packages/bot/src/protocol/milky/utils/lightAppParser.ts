// Parse light_app (mini-program) json_payload and extract URLs
// Milky light_app segment: app_name (string), json_payload (string, JSON data)
// Extract only from the jump-link field(s) defined by the mini-program structure; no filtering.

/**
 * Dot-separated paths where QQ mini-program json_payload stores the jump link (点击卡片跳转的链接).
 * Order matters: first found is used.
 * - meta.detail_1.qqdocurl: QQ share card (e.g. Bilibili) 分享链接
 */
const JUMP_LINK_PATHS = [
  'meta.detail_1.qqdocurl',
  'meta.jumpUrl',
  'meta.jump_url',
  'jumpUrl',
  'jump_url',
  'meta.url',
  'meta.link',
];

/**
 * Get value at dot-separated path in object (e.g. "meta.url" -> obj.meta?.url)
 */
function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const key of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/.+/.test(s.trim());
}

/**
 * Extract jump link URL from light_app json_payload string.
 * Only reads from JUMP_LINK_PATHS (the field that holds the share/jump URL); no other keys, no filtering.
 * @param jsonPayload - The json_payload string from light_app segment (may be snake_case or camelCase inside)
 * @returns List of URLs found at jump-link fields (deduplicated)
 */
export function extractUrlsFromLightAppPayload(jsonPayload: string): string[] {
  if (!jsonPayload || typeof jsonPayload !== 'string') {
    return [];
  }
  const trimmed = jsonPayload.trim();
  if (!trimmed) {
    return [];
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (obj === null || typeof obj !== 'object') {
    return [];
  }
  const record = obj as Record<string, unknown>;
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const path of JUMP_LINK_PATHS) {
    const value = getAtPath(record, path);
    if (typeof value !== 'string' || !isHttpUrl(value)) {
      continue;
    }
    const normalized = value.trim();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    urls.push(normalized);
  }

  return urls;
}
