/**
 * LogsBackend — SSE stream of the bot's log file.
 *
 * Routes:
 * - GET /api/logs/stream     SSE: lines appended to the newest file under logs/ from the moment the
 *                            client connects (no history), following the logger onto each new file
 */

import { botLogsDir, followLatestLog } from '@/utils/logFiles';
import { errorResponse } from './types';

const API_PREFIX = '/api/logs';

export class LogsBackend {
  readonly prefix = API_PREFIX;

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method !== 'GET') {
      return errorResponse('Method not allowed', 405);
    }

    if (subPath === '/stream') {
      return this.handleStream(req.signal);
    }

    return null;
  }

  private handleStream(signal: AbortSignal): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          if (signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // controller may be closed
          }
        };

        // Send an initial event so the client knows the connection is alive
        send('connected', { ts: Date.now() });

        followLatestLog(botLogsDir(), (text) => send('log', { text }), { signal, initialLines: 0 }).finally(() => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
