// JSON response helpers for the daemon's HTTP routes. `jsonResponse<T>` pins the wire shape
// at the response site, so a route cannot drift from the `@qqbot/api-types` contract silently.

import type { ErrorResponse } from '@qqbot/api-types';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function jsonResponse<T extends object>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse<ErrorResponse>({ error: message }, status);
}
