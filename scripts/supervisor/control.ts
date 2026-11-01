// The supervisor's HTTP control interface, served on 127.0.0.1. Each request must carry the token
// from the state file; every successful one answers with the bot's status after the operation.

import type { Supervisor } from './Supervisor';

type Controlled = Pick<Supervisor, 'status' | 'restart' | 'hold' | 'release' | 'close'>;

export function controlHandler(supervisor: Controlled, token: string, onStopped: () => void) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('authorization') !== `Bearer ${token}`) {
      return new Response('unauthorized', { status: 401 });
    }
    const route = `${request.method} ${new URL(request.url).pathname}`;
    switch (route) {
      case 'GET /status':
        break;
      case 'POST /restart':
        await supervisor.restart();
        break;
      case 'POST /bot/stop':
        await supervisor.hold();
        break;
      case 'POST /bot/start':
        await supervisor.release();
        break;
      case 'POST /stop':
        await supervisor.close();
        // After the response is written, so the caller hears that the stop completed.
        setTimeout(onStopped, 0);
        break;
      default:
        return new Response(`no route ${route}`, { status: 404 });
    }
    return Response.json(supervisor.status());
  };
}
