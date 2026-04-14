/**
 * LogsBackend — SSE stream of pm2 logs for the bot process.
 *
 * Routes:
 * - GET /api/logs/stream     SSE: log lines from `pm2 log qq-bot --raw --lines N`
 * - GET /api/logs/status     { available: boolean } — whether pm2 is reachable
 */

import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/logs';
const PM2_PROCESS_NAME = 'qq-bot';

export class LogsBackend {
  readonly prefix = API_PREFIX;

  async handle(pathname: string, req: Request): Promise<Response | null> {
    const subPath = pathname.slice(API_PREFIX.length);

    if (req.method !== 'GET') {
      return errorResponse('Method not allowed', 405);
    }

    if (subPath === '/status') {
      return this.handleStatus();
    }

    if (subPath === '/stream') {
      return this.handleStream(req.signal);
    }

    return null;
  }

  private async handleStatus(): Promise<Response> {
    try {
      const proc = Bun.spawn(['pm2', 'pid', PM2_PROCESS_NAME], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const pid = (await new Response(proc.stdout).text()).trim();
      return jsonResponse({ available: exitCode === 0 && pid !== '' && pid !== '0' });
    } catch {
      return jsonResponse({ available: false });
    }
  }

  private handleStream(signal: AbortSignal): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;

        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            // controller may be closed
          }
        };

        const close = () => {
          if (closed) return;
          closed = true;
          proc.kill();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        // Spawn pm2 log with --raw --lines 0: only stream new output, no history
        const proc = Bun.spawn(['pm2', 'log', PM2_PROCESS_NAME, '--raw', '--lines', '0'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        signal.addEventListener('abort', close);

        // Send an initial event so the client knows the connection is alive
        send('connected', { ts: Date.now() });

        // Read stdout
        const readStream = async (readable: ReadableStream<Uint8Array>, source: 'stdout' | 'stderr') => {
          const reader = readable.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || closed) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              // Keep the last incomplete line in the buffer
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                if (line.trim()) {
                  send('log', { text: line, source });
                }
              }
            }
            // Flush remaining buffer
            if (buffer.trim()) {
              send('log', { text: buffer, source });
            }
          } catch {
            // stream may close
          }
        };

        // Read both stdout and stderr concurrently
        Promise.all([
          readStream(proc.stdout as ReadableStream<Uint8Array>, 'stdout'),
          readStream(proc.stderr as ReadableStream<Uint8Array>, 'stderr'),
        ]).then(() => {
          if (!closed) {
            send('end', { reason: 'process_exit' });
            close();
          }
        });

        // Handle process exit
        proc.exited.then(() => {
          if (!closed) {
            send('end', { reason: 'process_exit' });
            close();
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
