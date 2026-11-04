/**
 * How long a hub_wait may block. Bun.serve cuts an idle request at 255 s, so the window stays
 * under it and a `timeout` answer means "call again". Claude Code enforces its own per-call MCP
 * limit (`MCP_TOOL_TIMEOUT`, well under a minute by default), so claude workers are launched with
 * that limit raised past the window; otherwise every wait longer than the default dies client-side
 * and the worker degrades to a 30 s poll.
 */
export const WAIT_MAX_MS = 240_000;
export const MCP_TOOL_CALL_TIMEOUT_MS = WAIT_MAX_MS + 60_000;
