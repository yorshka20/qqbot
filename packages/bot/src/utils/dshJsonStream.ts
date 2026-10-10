import { logger } from '@/utils/logger';

/**
 * Parse the DSH CLI's `--json` stdout into a clean final message.
 *
 * `dsh headless --json` writes newline-delimited run events. Every event but the
 * terminal `final` is capped at 8 KiB, so the `final` event's `text` is the only
 * lossless copy of the answer; a `text` event is the fallback when a run ends
 * without one (a turn that fails in-turn still emits `final`, often empty).
 *
 * Defensive: a run that never reached JSON mode (or a crash before any event)
 * falls back to the raw string verbatim. Never throws — parser failures are
 * logged and degrade to raw.
 */
export function parseDshJsonStream(raw: string): { finalMessage: string; rawEvents?: unknown[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { finalMessage: '' };

  // Heuristic: JSON mode produces lines starting with `{`. Anything else means the
  // CLI was not driven in JSON mode, so the bytes are already the answer.
  const firstLine = trimmed.split('\n', 1)[0];
  if (!firstLine.startsWith('{')) {
    return { finalMessage: raw };
  }

  const events: unknown[] = [];
  let finalText: string | undefined;
  let lastText: string | undefined;

  for (const line of trimmed.split('\n')) {
    const ln = line.trim();
    if (!ln) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      // Not JSON — could be a stray diagnostic, ignore.
      continue;
    }
    events.push(evt);

    if (evt.type === 'final' && typeof evt.text === 'string') {
      finalText = evt.text;
    }

    if (evt.type === 'text' && typeof evt.text === 'string') {
      lastText = evt.text;
    }
  }

  if (events.length === 0) {
    logger.warn('[dshJsonStream] saw JSON-ish input but parsed 0 events; falling back to raw');
    return { finalMessage: raw };
  }

  return { finalMessage: finalText ?? lastText ?? '', rawEvents: events };
}
