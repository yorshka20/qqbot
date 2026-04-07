/**
 * Backend interface for the static file server.
 * Each backend handles a URL prefix and returns a Response or null.
 */
export interface Backend {
  /** URL prefix this backend handles (e.g., '/api/memory') */
  readonly prefix: string;
  /** Handle a request. Return Response if handled, null if not matched. */
  handle(pathname: string, req: Request): Promise<Response | null> | Response | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Shared HTTP helpers (used across backends)
// ────────────────────────────────────────────────────────────────────────────

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
