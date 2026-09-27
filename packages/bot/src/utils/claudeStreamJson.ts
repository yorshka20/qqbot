import { logger } from '@/utils/logger';

/**
 * Parse claude CLI stdout into a clean final message.
 *
 * Supports both output modes of `claude --print`:
 *   - `--output-format text`: stdout is plain text, return as-is.
 *   - `--output-format stream-json`: stdout is JSONL where each line is a
 *     `{type, ...}` event. The terminal `result` event carries the final
 *     answer in its `result` field; falling back to the last `assistant`
 *     event's text content if no `result` shows up.
 *
 * Defensive: if the input is not JSONL (e.g. plain text mode, or claude
 * crashed before emitting any structured output), returns the raw string
 * verbatim. Never throws — parser failures are logged and degrade to raw.
 */
export function parseClaudeStreamJson(raw: string): { finalMessage: string; rawEvents?: unknown[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { finalMessage: '' };

  // Heuristic: stream-json mode produces lines starting with `{`. Plain
  // text mode rarely does. If the first non-empty line doesn't look like
  // JSON, short-circuit to the raw text path.
  const firstLine = trimmed.split('\n', 1)[0];
  if (!firstLine.startsWith('{')) {
    return { finalMessage: raw };
  }

  const events: unknown[] = [];
  let resultText: string | undefined;
  let lastAssistantText: string | undefined;

  for (const line of trimmed.split('\n')) {
    const ln = line.trim();
    if (!ln) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      // Not JSON — could be a stray log line, ignore.
      continue;
    }
    events.push(evt);

    // The `result` event is claude's terminal "here's the final answer"
    // event. Its shape is `{type: "result", subtype: "success", result: "..."}`.
    if (evt.type === 'result' && typeof evt.result === 'string') {
      resultText = evt.result;
    }

    // Track assistant messages as a fallback. Schema:
    //   {type: "assistant", message: {role, content: [{type: "text", text: "..."}]}}
    if (evt.type === 'assistant' && typeof evt.message === 'object' && evt.message !== null) {
      const msg = evt.message as { content?: unknown };
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string'
          ) {
            lastAssistantText = (part as { text: string }).text;
          }
        }
      }
    }
  }

  if (events.length === 0) {
    // First line looked like JSON but nothing parsed — bail to raw.
    logger.warn(`[claudeStreamJson] saw JSON-ish input but parsed 0 events; falling back to raw`);
    return { finalMessage: raw };
  }

  const finalMessage = resultText ?? lastAssistantText ?? raw;
  return { finalMessage, rawEvents: events };
}
